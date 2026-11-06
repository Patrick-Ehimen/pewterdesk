import { beforeEach, describe, expect, it } from "vitest";
import {
  type AppNote,
  clearNotes,
  currentNotes,
  mergeNotes,
  notifyEvent,
} from "../src/lib/notifications";

const note = (id: string, time: number, read = false): AppNote => ({
  id,
  type: "alert",
  title: id,
  tone: "neutral",
  time,
  read,
});

describe("notifications kept in the cloud", () => {
  beforeEach(() => clearNotes());

  it("counts a new one as unread, toast or not", () => {
    notifyEvent({ type: "alert", title: "BTC" });
    expect(currentNotes()[0]?.read).toBe(false);
  });

  it("merges the cloud's in time order, read on either side read", () => {
    notifyEvent({ type: "alert", title: "here" });
    const here = currentNotes()[0] as AppNote;
    mergeNotes([
      note("a-1", here.time - 2000),
      { ...here, read: true },
      note("a-2", here.time + 1000),
    ]);
    const list = currentNotes();
    expect(list.map((n) => n.id)).toEqual(["a-2", here.id, "a-1"]);
    expect(list.find((n) => n.id === here.id)?.read).toBe(true);
    // Merging again changes nothing.
    mergeNotes([note("a-1", here.time - 2000)]);
    expect(currentNotes()).toHaveLength(3);
  });
});
