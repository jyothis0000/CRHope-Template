/**
 * PostHog analytics behind cookie consent.
 *
 * - Nothing loads until the browser is idle; events fired before that are queued
 *   and replayed with their original timestamps.
 * - Capturing is opted out until the visitor accepts (cookieless on reject).
 * - Pageviews follow ClientRouter navigations; clicks on [data-cta] elements and
 *   key links become `cta_clicked`, other off-site links `outbound_link_clicked`.
 * - Without PUBLIC_POSTHOG_KEY everything here is a silent no-op.
 *
 * Add ?internal=on to any URL to stop tracking this browser (?internal=off undoes it).
 */
import type { PostHog } from "posthog-js";

// ---------------------------------------------------------------------------
// Page classification. One page today; add entries here as pages are added.
// ---------------------------------------------------------------------------

type PageInfo = { area: string; type: string; tool: string | null; niche: string | null; locale: string };

const withTrailingSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);

function classifyPage(pathname: string): PageInfo {
  const path = withTrailingSlash(pathname || "/");
  return { area: "site", type: path === "/" ? "home" : "other", tool: null, niche: null, locale: "en" };
}

/** What kind of destination a link points to. */
function linkIntent(url: URL, origin: string) {
  if (url.protocol === "mailto:") return "email";
  if (/(^|.)(globalgiving.org|paypal.me|paypal.com)$/.test(url.hostname)) return "donate";
  if (url.pathname.includes("become-a-volunteer")) return "volunteer";
  if (/(^|.)(instagram|facebook|linkedin|youtube|tiktok|twitter).com$/.test(url.hostname)) return "social";
  if (url.origin === origin) return "internal";
  return "external";
}

// ---------------------------------------------------------------------------
// PostHog loading and the event queue
// ---------------------------------------------------------------------------

const INTERNAL_KEY = "crhope_internal";

function isInternalVisitor() {
  try {
    const flag = new URLSearchParams(location.search).get("internal");
    if (flag === "on") localStorage.setItem(INTERNAL_KEY, "1");
    if (flag === "off") localStorage.removeItem(INTERNAL_KEY);
    return localStorage.getItem(INTERNAL_KEY) === "1";
  } catch {
    return false;
  }
}

const POSTHOG_KEY: string | undefined = isInternalVisitor() ? undefined : import.meta.env.PUBLIC_POSTHOG_KEY || undefined;
const POSTHOG_HOST: string = import.meta.env.PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com";
const VISIT_KEY = "crhope_visit";
const CONSENT_CHANGE_EVENT = "crhope:consent-change";
const CONSENT_OPEN_EVENT = "crhope:consent-open";

type Properties = Record<string, unknown>;
type QueuedEvent = { event: string; properties: Properties; timestamp: Date; beacon: boolean };

let posthog: PostHog | null = null;
let loadStarted = false;
const eventQueue: QueuedEvent[] = [];
const readyQueue: Array<() => void> = [];

function capture(event: string, properties: Properties = {}, beacon = false) {
  if (!POSTHOG_KEY) return;
  if (posthog) {
    posthog.capture(event, properties, beacon ? { transport: "sendBeacon" } : undefined);
    return;
  }
  // Not loaded yet: keep the context of the moment the event happened.
  eventQueue.push({
    event,
    properties: { ...properties, $current_url: location.href, $pathname: location.pathname, title: document.title },
    timestamp: new Date(),
    beacon,
  });
}

/** Runs `callback` once PostHog has loaded (right away if it already has). */
export function whenReady(callback: () => void) {
  if (!POSTHOG_KEY) return;
  if (posthog) callback();
  else readyQueue.push(callback);
}

function loadPostHog() {
  if (!POSTHOG_KEY || loadStarted) return;
  loadStarted = true;
  import("posthog-js").then(({ default: client }) => {
    client.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      person_profiles: "identified_only",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      enable_heatmaps: true,
      before_send: (event) => {
        if (!event) return event;
        event.properties = {
          ...visitProperties(),
          site_env: siteEnv(),
          consent: client.get_explicit_consent_status(),
          ...event.properties,
        };
        return event;
      },
    });
    posthog = client;
    saveVisit();
    for (const { event, properties, timestamp, beacon } of eventQueue.splice(0)) {
      client.capture(event, properties, { timestamp, ...(beacon ? { transport: "sendBeacon" as const } : {}) });
    }
    for (const callback of readyQueue.splice(0)) callback();
  });
}

function siteEnv() {
  const host = location.hostname;
  // ponytail: production = the `site` host from astro.config .
  const siteHost = import.meta.env.SITE ? new URL(import.meta.env.SITE).hostname.replace(/^www\./, "") : "";
  if (host === siteHost || host === `www.${siteHost}`) return "production";
  if (host === "localhost" || host === "127.0.0.1") return "development";
  return host.includes("staging") ? "staging" : "preview";
}

// ---------------------------------------------------------------------------
// Visit: where this session landed and which tools it has seen.
// Kept in sessionStorage only while consent is granted.
// ---------------------------------------------------------------------------

type Visit = {
  landingArea: string;
  landingType: string;
  landingTool: string | null;
  landingPath: string;
  toolsSeen: string[];
  lastTool: string | null;
  reachedStudio: boolean;
};

let visit: Visit | null = null;

function newVisit(page: PageInfo): Visit {
  return {
    landingArea: page.area,
    landingType: page.type,
    landingTool: page.tool,
    landingPath: location.pathname,
    toolsSeen: [],
    lastTool: null,
    reachedStudio: false,
  };
}

function saveVisit() {
  if (!visit || !posthog) return;
  try {
    if (getConsentStatus() === "granted") sessionStorage.setItem(VISIT_KEY, JSON.stringify(visit));
    else sessionStorage.removeItem(VISIT_KEY);
  } catch {}
}

function readVisit(): Visit | null {
  try {
    const saved = sessionStorage.getItem(VISIT_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function clearPostHogStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      for (const key of Object.keys(storage)) {
        if (key.startsWith("ph_")) storage.removeItem(key);
      }
    } catch {}
  }
}

function visitProperties(): Properties {
  if (!visit) return {};
  return {
    landing_area: visit.landingArea,
    landing_page_type: visit.landingType,
    landing_tool: visit.landingTool,
    landing_path: visit.landingPath,
    landed_on_tools: visit.landingArea === "tools",
    visit_saw_tool: visit.toolsSeen.length > 0,
  };
}

function currentPage(): PageInfo {
  const page = classifyPage(location.pathname);
  // Niche pages expose the untranslated niche id; prefer it over the URL slug.
  const nicheId = document.querySelector<HTMLElement>("[data-niche-id]")?.dataset.nicheId;
  return nicheId && page.niche ? { ...page, niche: nicheId } : page;
}

function pageProperties(page = currentPage()): Properties {
  return { page_area: page.area, page_type: page.type, tool: page.tool, niche: page.niche, page_locale: page.locale };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ConsentStatus = "granted" | "denied" | "pending";

export function isAnalyticsEnabled() {
  return !!POSTHOG_KEY;
}

export function getConsentStatus(): ConsentStatus {
  return posthog ? posthog.get_explicit_consent_status() : "pending";
}

export function setConsent(granted: boolean) {
  if (!posthog) return;
  if (granted) {
    posthog.opt_in_capturing();
  } else {
    posthog.opt_out_capturing();
    clearPostHogStorage();
  }
  saveVisit();
  document.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT));
}

/** Asks the cookie banner to show itself again (e.g. a "cookie settings" link). */
export function openCookieSettings() {
  document.dispatchEvent(new CustomEvent(CONSENT_OPEN_EVENT));
}

export function onConsent(type: "change" | "open", callback: (status: ConsentStatus) => void) {
  document.addEventListener(type === "change" ? CONSENT_CHANGE_EVENT : CONSENT_OPEN_EVENT, () =>
    callback(getConsentStatus()),
  );
}

/** Custom event with the visit and page context attached. */
export function track(event: string, properties: Properties = {}, options: { beacon?: boolean } = {}) {
  capture(event, { ...visitProperties(), ...pageProperties(), ...properties }, options.beacon);
}

// ---------------------------------------------------------------------------
// Automatic tracking
// ---------------------------------------------------------------------------

let lastTrackedPath: string | null = null;

function trackPageview() {
  const path = location.pathname + location.search;
  if (path === lastTrackedPath) return;
  lastTrackedPath = path;

  const page = currentPage();
  visit ??= newVisit(page);
  if (page.tool) {
    if (!visit.toolsSeen.includes(page.tool)) visit.toolsSeen.push(page.tool);
    visit.lastTool = page.tool;
  }
  capture("$pageview", { ...visitProperties(), ...pageProperties(page) });
  observeCtaViews();

  // First studio page after using a tool: the conversion we care about.
  if (page.area === "studio" && visit.toolsSeen.length > 0 && !visit.reachedStudio) {
    visit.reachedStudio = true;
    capture("tool_to_studio", {
      ...visitProperties(),
      studio_page: page.type,
      from_tool: visit.lastTool,
      first_tool: visit.toolsSeen[0],
      tools_seen: [...visit.toolsSeen],
    });
  }
  saveVisit();
}

let ctaViewObserver: IntersectionObserver | null = null;

/** `cta_viewed` once per [data-cta-view] id and page, when half of it is on screen. */
function observeCtaViews() {
  ctaViewObserver?.disconnect();
  ctaViewObserver = null;
  const targets = document.querySelectorAll<HTMLElement>("[data-cta-view]");
  if (targets.length === 0 || typeof IntersectionObserver !== "function") return;

  const seen = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        observer.unobserve(target);
        const id = target.dataset.ctaView;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        capture("cta_viewed", { cta_view_id: id, ...visitProperties(), ...pageProperties() });
      }
    },
    { threshold: 0.5 },
  );
  targets.forEach((target) => observer.observe(target));
  ctaViewObserver = observer;
}

const cleanText = (text: string | null | undefined, max = 80) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function onClick(event: MouseEvent) {
  // Left or middle button only.
  if (event.button !== 0 && event.button !== 1) return;
  const target = event.target as HTMLElement | null;
  if (!target?.closest) return;

  const cta = target.closest<HTMLElement>("[data-cta]");
  const link = target.closest<HTMLAnchorElement>("a[href]");
  let url: URL | null = null;
  if (link) {
    try {
      url = new URL(link.href, location.href);
    } catch {
      url = null;
    }
  }
  const section = target.closest<HTMLElement>("[data-cta-section]")?.dataset.ctaSection ?? null;
  const intent = url ? linkIntent(url, location.origin) : null;
  // Untagged links still count as CTAs inside a [data-cta-section] or when they book, email or go to a studio page.
  const inlineCta =
    !cta && !!intent && (!!section || intent === "book_call" || intent === "email" || intent.startsWith("studio_"));

  if (cta || inlineCta) {
    capture(
      "cta_clicked",
      {
        cta_id: cta?.dataset.cta ?? `${section ?? "inline"}_${intent}`,
        cta_text: cleanText((cta ?? link)?.textContent),
        cta_intent: intent ?? "action",
        cta_href: url?.href ?? null,
        cta_section: section,
        cta_inline: !cta,
        ...visitProperties(),
        ...pageProperties(),
      },
      true,
    );
    return;
  }

  if (url && url.origin !== location.origin && /^(https?|mailto):$/.test(url.protocol)) {
    capture(
      "outbound_link_clicked",
      {
        link_url: url.href,
        link_domain: url.protocol === "mailto:" ? "mailto" : url.hostname,
        link_text: cleanText(link?.textContent),
        link_intent: intent,
        link_context: target.closest<HTMLElement>("[data-outbound]")?.dataset.outbound ?? null,
        ...visitProperties(),
        ...pageProperties(),
      },
      true,
    );
  }
}

function init() {
  if (!POSTHOG_KEY) return;
  visit = readVisit();
  trackPageview();
  document.addEventListener("astro:page-load", trackPageview);
  document.addEventListener("astro:before-preparation", (event) => {
    const to = (event as Event & { to?: URL }).to;
    if (!posthog || (to && to.pathname + to.search === location.pathname + location.search)) return;
    posthog.capture("$pageleave", pageProperties());
  });
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("auxclick", onClick, { capture: true });
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(loadPostHog, { timeout: 3000 });
  else globalThis.setTimeout(loadPostHog, 1500);
}

init();
