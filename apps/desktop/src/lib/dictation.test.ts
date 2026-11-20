import { describe, expect, it } from "vitest";
import { joinSpoken } from "./dictation";

describe("dictation", () => {
  it("types as said into an empty box", () => {
    expect(joinSpoken("", "Buy the dip.")).toBe("Buy the dip.");
  });

  it("adds a space after a word, and lowers the first letter mid-sentence", () => {
    expect(joinSpoken("Funding is", "Rising fast")).toBe(" rising fast");
    expect(joinSpoken("Funding is ", "Rising fast")).toBe("rising fast");
  });

  it("keeps the capital after a full stop or a new line", () => {
    expect(joinSpoken("Done. ", "Next trade")).toBe("Next trade");
    expect(joinSpoken("Done.\n", "Next trade")).toBe("Next trade");
  });

  it("keeps I and acronyms as they are", () => {
    expect(joinSpoken("so", "I think so")).toBe(" I think so");
    expect(joinSpoken("watch", "BTC first")).toBe(" BTC first");
  });

  it("leaves a space before the words that follow", () => {
    expect(joinSpoken("", "long", "BTC")).toBe("long ");
    expect(joinSpoken("", "long", ". then")).toBe("long");
  });

  it("types nothing for nothing heard", () => {
    expect(joinSpoken("abc", "   ")).toBe("");
  });
});
