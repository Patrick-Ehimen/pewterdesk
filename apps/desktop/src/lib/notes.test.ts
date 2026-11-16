import { describe, expect, it } from "vitest";
import {
  continueList,
  mergeNotes,
  type Note,
  noteTitle,
  renumber,
  restoreNote,
  searchNotes,
  toggleCheck,
  toggleFormat,
} from "./notes";

const ID = "8e5c1f0a-3b4d-4c6e-9f10-2a3b4c5d6e7f";
const ID2 = "1e5c1f0a-3b4d-4c6e-9f10-2a3b4c5d6e7f";
const note = (id: string, text: string, updatedAt: number): Note => ({
  id,
  text,
  createdAt: 0,
  updatedAt,
});

describe("notes", () => {
  it("titles a note by its first line with words, marks left off", () => {
    expect(noteTitle("\n\n## Meme Notes\n1. one")).toBe("Meme Notes");
    expect(noteTitle("1. Let's try trading")).toBe("Let's try trading");
    expect(noteTitle("- [ ] check funding")).toBe("check funding");
    expect(noteTitle("   ")).toBe("");
  });

  it("restores only what is a note", () => {
    expect(restoreNote(ID, { text: "hi", updatedAt: 5 })).toEqual({
      id: ID,
      text: "hi",
      createdAt: 5,
      updatedAt: 5,
    });
    expect(restoreNote("not-a-uuid", { text: "hi" })).toBeUndefined();
    expect(restoreNote(ID, { text: 3 })).toBeUndefined();
  });

  it("continues a numbered list, and ends it on an empty item", () => {
    const text = "1. Let's try trading between 8am-12pm.";
    const e = continueList(text, text.length);
    expect(e?.text).toBe(`${text}\n2. `);
    expect(e?.caret).toBe(text.length + 4);
    const ended = continueList(`${text}\n2. `, text.length + 4);
    expect(ended?.text).toBe(`${text}\n`);
  });

  it("continues bullets and checklists, unticked", () => {
    expect(continueList("- a", 3)?.text).toBe("- a\n- ");
    expect(continueList("- [x] a", 7)?.text).toBe("- [x] a\n- [ ] ");
    expect(continueList("plain", 5)).toBeUndefined();
    expect(continueList("## Title", 8)).toBeUndefined();
  });

  it("renumbers a list after a line goes in the middle", () => {
    expect(renumber("1. a\n2. new\n2. b\n3. c", 6)).toBe("1. a\n2. new\n3. b\n4. c");
  });

  it("turns lines into a list and back", () => {
    const on = toggleFormat("a\nb", 0, 3, "number");
    expect(on.text).toBe("1. a\n2. b");
    expect(toggleFormat(on.text, 0, on.text.length, "number").text).toBe("a\nb");
    expect(toggleFormat("1. a", 0, 0, "bullet").text).toBe("- a");
    expect(toggleFormat("Title", 0, 0, "heading").text).toBe("## Title");
  });

  it("ticks a checklist item", () => {
    expect(toggleCheck("- [ ] a", 3)?.text).toBe("- [x] a");
    expect(toggleCheck("- [x] a", 3)?.text).toBe("- [ ] a");
    expect(toggleCheck("a", 0)).toBeUndefined();
  });

  it("searches every word", () => {
    const notes = [note(ID, "Trading between 8am-12pm", 1), note(ID2, "community", 2)];
    expect(searchNotes(notes, "trading 8am").map((n) => n.id)).toEqual([ID]);
    expect(searchNotes(notes, "")).toHaveLength(2);
  });

  it("merges by the later change, and keeps deletions deleted", () => {
    const local = [note(ID, "newer here", 10)];
    const cloud = [note(ID, "older there", 5), note(ID2, "only there", 7)];
    const { notes, toPush } = mergeNotes(local, cloud, new Set());
    expect(notes.map((n) => n.text)).toEqual(["newer here", "only there"]);
    expect(toPush.map((n) => n.id)).toEqual([ID]);
    expect(mergeNotes([], cloud, new Set([ID2])).notes.map((n) => n.id)).toEqual([ID]);
    // The cloud's later copy wins, and nothing goes up.
    expect(mergeNotes([note(ID, "old", 1)], cloud, new Set()).toPush).toEqual([]);
  });
});
