import { type RefObject, useEffect } from "react";
import { type SlideState, slideStep } from "../lib/autoSlide";

/**
 * Slides `ref`'s element along when its content is wider than it: to the
 * end, a rest, back, a rest. It holds still while the pointer is over it or
 * focus is in it (so a chip can be clicked), after the trader scrolls it
 * themselves, and not at all with reduced motion; it starts from wherever
 * it was left.
 */
export function useAutoSlide(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let held = false;
    let state: SlideState = { pos: el.scrollLeft, dir: 1 };
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const elapsed = Math.min(now - last, 100);
      last = now;
      const max = el.scrollWidth - el.clientWidth;
      if (held) {
        // Pick up from wherever the trader left it.
        state = { pos: el.scrollLeft, dir: state.dir };
      } else {
        state = slideStep(state, max, elapsed, now);
        el.scrollLeft = state.pos;
      }
      frame = requestAnimationFrame(tick);
    });
    const hold = () => {
      held = true;
    };
    const release = () => {
      held = el.matches(":hover") || el.contains(document.activeElement);
    };
    el.addEventListener("pointerenter", hold);
    el.addEventListener("pointerleave", release);
    // Focus moves after focusout fires: look once it has landed.
    const left = () => {
      setTimeout(release);
    };
    el.addEventListener("focusin", hold);
    el.addEventListener("focusout", left);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerenter", hold);
      el.removeEventListener("pointerleave", release);
      el.removeEventListener("focusin", hold);
      el.removeEventListener("focusout", left);
    };
  }, [ref]);
}
