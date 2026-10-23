import { describe, expect, it } from "vitest";
import { SLIDE_REST_MS, SLIDE_SPEED, slideStep } from "../src/lib/autoSlide";

describe("slideStep", () => {
  it("glides to the end, rests, then glides back", () => {
    let s = slideStep({ pos: 0, dir: 1 }, 100, 1000, 0);
    expect(s.pos).toBe(SLIDE_SPEED);
    s = slideStep({ pos: 90, dir: 1 }, 100, 1000, 5000);
    expect(s).toEqual({ pos: 100, dir: -1, restUntil: 5000 + SLIDE_REST_MS });
    // Resting: it stays put until the rest is over.
    expect(slideStep(s, 100, 16, 5500)).toBe(s);
    s = slideStep(s, 100, 1000, 5000 + SLIDE_REST_MS);
    expect(s.pos).toBe(100 - SLIDE_SPEED);
    expect(s.dir).toBe(-1);
  });

  it("turns at the start too", () => {
    expect(slideStep({ pos: 5, dir: -1 }, 100, 1000, 10)).toEqual({
      pos: 0,
      dir: 1,
      restUntil: 10 + SLIDE_REST_MS,
    });
  });

  it("stays home when everything fits", () => {
    expect(slideStep({ pos: 40, dir: -1 }, 0, 1000, 0)).toEqual({ pos: 0, dir: 1 });
    expect(slideStep({ pos: 40, dir: 1 }, -5, 1000, 0)).toEqual({ pos: 0, dir: 1 });
  });
});
