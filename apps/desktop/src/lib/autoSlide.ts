// An automatic slider for a strip wider than its room (the header's venue
// chips): it glides to one end, rests, glides back, and so on. Plain logic,
// one step per animation frame; `useAutoSlide` drives it.

/** Pixels a second it glides. */
export const SLIDE_SPEED = 24;
/** How long it rests at each end, in milliseconds. */
export const SLIDE_REST_MS = 1500;

export interface SlideState {
  /** Where it is, 0 to `max`. */
  pos: number;
  /** Which way it's going: 1 toward the end, -1 back to the start. */
  dir: 1 | -1;
  /** Resting at an end until this time (ms), if it is. */
  restUntil?: number;
}

/**
 * The slide `elapsed` ms after `s`, at `now`, for a strip that scrolls up
 * to `max` pixels. Nothing to slide (`max` 0 or less) brings it home and
 * keeps it there.
 */
export function slideStep(s: SlideState, max: number, elapsed: number, now: number): SlideState {
  if (max <= 0) return { pos: 0, dir: 1 };
  if (s.restUntil !== undefined && now < s.restUntil) return s;
  const pos = Math.min(max, Math.max(0, s.pos + (s.dir * SLIDE_SPEED * elapsed) / 1000));
  if (s.dir === 1 && pos >= max) return { pos: max, dir: -1, restUntil: now + SLIDE_REST_MS };
  if (s.dir === -1 && pos <= 0) return { pos: 0, dir: 1, restUntil: now + SLIDE_REST_MS };
  return { pos, dir: s.dir };
}
