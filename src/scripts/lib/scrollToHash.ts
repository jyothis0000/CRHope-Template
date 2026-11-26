// Same-page #section scrolling that goes through ScrollSmoother when it's active.
import { gsap } from "gsap";
import { ScrollSmoother } from "gsap/ScrollSmoother";

export function findHashTarget(hash: string) {
  if (hash.length < 2) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
}

export function scrollToTarget(target: HTMLElement, smooth: boolean) {
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const smoother = ScrollSmoother.get();
  if (smoother) {
    const contentY = Number(gsap.getProperty(smoother.content(), "y")) || 0;
    const top = target.getBoundingClientRect().top - contentY;
    smoother.scrollTo(Math.max(0, top - margin), smooth);
  } else {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: smooth && !reduced ? "smooth" : "auto", block: "start" });
  }
}
