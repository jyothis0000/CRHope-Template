// SVG-filter version of the noise dissolve: works on any element (text, HTML) via `filter: url(#…)`.
// The noise texture is tiled with feTile, thresholded into an alpha mask, toned, and optionally
// displaced ("static" variant) — no canvas readback, so it is cheap for big blocks of text.
import { NOISE_DEFAULTS, clamp01, easeOutCubic, getNoiseTextureUrl, hash01, prefersReducedMotion } from "./noiseDissolve";
import type { NoiseOptions } from "./noiseDissolve";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MASK_GAIN = 255; // steepness of the threshold: alpha jumps from 0 to 1 within 1/255 of noise value
const OVERSHOOT = 1.004; // progress 1 pushes the cutoff just past the brightest noise value
const MAX_DPR = 2;

let filterHost: SVGSVGElement | null = null;
let filterCount = 0;
const ID_PREFIX = `noise-filter-${Math.random().toString(36).slice(2, 8)}`;

/** A hidden zero-size <svg> at the end of <body> that holds all generated filters. */
export function getFilterHost(): SVGSVGElement {
  if (filterHost?.isConnected) return filterHost;
  filterHost = document.createElementNS(SVG_NS, "svg");
  filterHost.setAttribute("aria-hidden", "true");
  filterHost.setAttribute("focusable", "false");
  Object.assign(filterHost.style, {
    position: "absolute",
    width: "0",
    height: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  document.body.append(filterHost);
  return filterHost;
}

export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
}

/** Hides/shows `element` by dissolving it through the noise texture. progress 0 = visible, 1 = gone. */
export class NoiseFilter {
  element: HTMLElement;
  getOptions: () => Partial<NoiseOptions>;
  filter: SVGFilterElement;
  image: SVGFEImageElement;
  mask: SVGFEColorMatrixElement;
  tone: SVGFEColorMatrixElement;
  displace: SVGFEDisplacementMapElement;
  textureSize = 256;
  width = 0;
  height = 0;
  progress = 0;
  tween: Tween | null = null;
  concealed = false;
  frame = 0;
  lastStep = NaN;
  destroyed = false;
  seed = Math.floor(Math.random() * 1e6);
  id = `${ID_PREFIX}-${++filterCount}`;
  textureLoaded = false;

  constructor(element: HTMLElement, getOptions: () => Partial<NoiseOptions> = () => ({})) {
    this.element = element;
    this.getOptions = getOptions;
    this.filter = createSvgElement("filter", {
      id: this.id,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    this.image = createSvgElement("feImage", { preserveAspectRatio: "none", result: "tile" });
    this.mask = createSvgElement("feColorMatrix", { in: "noise", type: "matrix", result: "mask" });
    this.tone = createSvgElement("feColorMatrix", { in: "noise", type: "matrix", result: "tone" });
    this.displace = createSvgElement("feDisplacementMap", {
      in: "masked",
      in2: "noise",
      scale: 0,
      xChannelSelector: "G",
      yChannelSelector: "B",
    });
    this.filter.append(
      this.image,
      createSvgElement("feTile", { in: "tile", result: "noise" }),
      this.mask,
      this.tone,
      // alpha = mask × tone
      createSvgElement("feComposite", {
        in: "mask",
        in2: "tone",
        operator: "arithmetic",
        k1: 1,
        k2: 0,
        k3: 0,
        k4: 0,
        result: "alpha",
      }),
      createSvgElement("feComposite", { in: "SourceGraphic", in2: "alpha", operator: "in", result: "masked" }),
      this.displace,
    );
  }

  get isActive() {
    return this.tween !== null;
  }

  get isHidden() {
    return this.concealed && !this.tween && this.progress >= 1;
  }

  /** Hide immediately, no animation. */
  conceal() {
    if (this.destroyed) return;
    this.stop();
    this.concealed = true;
    this.progress = 1;
    this.element.style.filter = "";
    this.element.style.visibility = "hidden";
  }

  show(duration?: number) {
    if (this.destroyed) return;
    if (prefersReducedMotion()) {
      this.settle(false);
      return;
    }
    this.concealed = false;
    this.tweenTo(0, duration ?? this.options().inDuration);
    this.begin();
  }

  hide(duration?: number) {
    if (this.destroyed || this.isHidden) return;
    if (prefersReducedMotion()) {
      this.conceal();
      return;
    }
    this.concealed = true;
    this.tweenTo(1, duration ?? this.options().outDuration);
    this.begin();
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.element.style.filter = "";
    this.element.style.visibility = "";
    this.filter.remove();
  }

  options(): NoiseOptions {
    return { ...NOISE_DEFAULTS, ...this.getOptions() };
  }

  tweenTo(to: number, duration: number) {
    const distance = Math.abs(to - this.progress);
    if (distance === 0) {
      this.tween = null;
      return;
    }
    this.tween = { from: this.progress, to, start: performance.now(), duration: Math.max(1, duration * distance) };
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.tween = null;
  }

  /** End state without a filter: fully hidden or fully shown. */
  settle(hidden: boolean) {
    this.stop();
    this.progress = hidden ? 1 : 0;
    this.concealed = hidden;
    this.element.style.filter = "";
    this.element.style.visibility = hidden ? "hidden" : "";
  }

  async begin() {
    let size: number;
    try {
      ({ size } = await this.loadTexture());
    } catch {
      this.settle(this.concealed);
      return;
    }
    if (this.destroyed) return;
    if (!this.tween) {
      this.settle(this.concealed && this.progress >= 1);
      return;
    }
    this.textureSize = size;
    this.width = this.element.offsetWidth;
    this.height = this.element.offsetHeight;
    if (!this.filter.isConnected) getFilterHost().append(this.filter);
    this.update(this.progress, performance.now());
    this.element.style.filter = `url(#${this.id})`;
    this.element.style.visibility = "";
    this.frame ||= requestAnimationFrame(this.tick);
  }

  async loadTexture() {
    const texture = await getNoiseTextureUrl();
    if (!this.textureLoaded) {
      this.textureLoaded = true;
      this.image.setAttribute("href", texture.url);
      this.image.setAttributeNS(XLINK_NS, "xlink:href", texture.url);
    }
    return texture;
  }

  tick = (time: number) => {
    this.frame = 0;
    if (this.destroyed) return;
    const tween = this.tween;
    if (tween) {
      const t = clamp01((time - tween.start) / tween.duration);
      this.progress = tween.from + (tween.to - tween.from) * easeOutCubic(t);
      if (t >= 1) {
        this.progress = tween.to;
        this.tween = null;
      }
    }
    if (!this.tween) {
      this.settle(this.concealed && this.progress >= 1);
      return;
    }
    const fps = this.options().fps;
    const step = fps > 0 ? Math.floor((time * fps) / 1000) : time;
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.update(this.progress, time);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  update(progress: number, time: number) {
    const options = this.options();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const grain = Math.max(1, Math.round(options.grain * dpr)) / dpr; // CSS px per noise texel, snapped to device px
    const size = this.textureSize;
    const tileSize = size * grain;
    const displacement = options.variant === "static" ? options.scatter * 2 * progress : 0;
    const padding = tileSize + options.scatter * 2 + 2;

    this.filter.setAttribute("x", String(-padding));
    this.filter.setAttribute("y", String(-padding));
    this.filter.setAttribute("width", String(this.width + padding * 2));
    this.filter.setAttribute("height", String(this.height + padding * 2));

    // Boil: jump the tile to a new random offset each step.
    const boilStep = options.boil > 0 ? Math.floor((time * options.boil) / 1000) : 0;
    const shiftX = Math.floor(hash01(this.seed + boilStep * 7919) * size);
    const shiftY = Math.floor(hash01(this.seed + boilStep * 7919 + 1) * size);
    this.image.setAttribute("x", String(-padding + shiftX * grain));
    this.image.setAttribute("y", String(-padding + shiftY * grain));
    this.image.setAttribute("width", String(tileSize));
    this.image.setAttribute("height", String(tileSize));

    const cutoff = progress * OVERSHOOT;
    const tone = clamp01(options.tone) * progress;
    this.mask.setAttribute("values", `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${MASK_GAIN} 0 0 0 ${1 - MASK_GAIN * cutoff}`);
    this.tone.setAttribute("values", `0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 ${tone} 0 ${1 - tone}`);
    this.displace.setAttribute("scale", String(displacement));
  }
}
