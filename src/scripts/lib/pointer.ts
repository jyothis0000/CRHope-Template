// Mouse/trackpad vs touch. Touch screens get lighter effects.
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function hasFinePointer() {
  return window.matchMedia(FINE_POINTER_QUERY).matches;
}

/** ScrollTrigger `scrub` value: tightly locked on fine pointers, smoothed on touch. */
export function pointerScrub(touchSmoothing = 0.6): true | number {
  return hasFinePointer() ? true : touchSmoothing;
}
