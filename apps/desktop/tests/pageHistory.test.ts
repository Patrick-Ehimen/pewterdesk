import { describe, expect, it } from "vitest";
import { startHistory, stepped, stepTo, visited } from "../src/lib/pageHistory";

describe("page history", () => {
  it("walks back and forward through the pages opened", () => {
    let h = startHistory("trade");
    expect(stepTo(h, -1)).toBeUndefined();
    expect(stepTo(h, 1)).toBeUndefined();
    h = visited(visited(h, "portfolio"), "news");
    expect(stepTo(h, -1)).toBe("portfolio");
    h = stepped(h, -1);
    // Arriving there by the button adds nothing.
    expect(visited(h, "portfolio")).toBe(h);
    expect(stepTo(h, -1)).toBe("trade");
    expect(stepTo(h, 1)).toBe("news");
    expect(stepTo(stepped(h, 1), 1)).toBeUndefined();
  });

  it("drops what was ahead once another page is opened", () => {
    let h = visited(visited(startHistory("trade"), "portfolio"), "news");
    h = stepped(stepped(h, -1), -1);
    h = visited(h, "maps");
    expect(h.entries).toEqual(["trade", "maps"]);
    expect(stepTo(h, 1)).toBeUndefined();
    // Nowhere to go: the same history.
    expect(stepped(h, 1)).toBe(h);
  });

  it("keeps a bounded trail", () => {
    let h = startHistory("trade");
    for (let i = 0; i < 200; i++) h = visited(h, i % 2 ? "trade" : "news");
    expect(h.entries.length).toBe(50);
    expect(h.index).toBe(49);
  });
});
