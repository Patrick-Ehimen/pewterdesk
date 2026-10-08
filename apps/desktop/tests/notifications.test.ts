import { describe, expect, it } from "vitest";
import {
  type AppNote,
  channelsFor,
  DEFAULT_NOTE_SETTINGS,
  loadNoteSettings,
  loadNotes,
  MAX_NOTES,
  withNote,
} from "../src/lib/notifications";

const store = (items: Record<string, string> = {}) => ({
  getItem: (k: string) => items[k] ?? null,
  setItem: (k: string, v: string) => {
    items[k] = v;
  },
});
const note = (i: number): AppNote => ({
  id: String(i),
  type: "fill",
  title: `n${i}`,
  tone: "neutral",
  time: i,
  read: false,
});

describe("notifications", () => {
  it("delivers each type where its settings say", () => {
    const s = DEFAULT_NOTE_SETTINGS;
    expect(channelsFor(s, "fill")).toEqual(["toast", "desktop", "sound"]);
    expect(channelsFor(s, "order")).toEqual(["toast", "sound"]);
    const quiet = {
      ...s,
      types: { ...s.types, fill: { toast: true, desktop: false, sound: false } },
    };
    expect(channelsFor(quiet, "fill")).toEqual(["toast"]);
  });

  it("narrows to an alert's own channels", () => {
    expect(channelsFor(DEFAULT_NOTE_SETTINGS, "alert", ["desktop"])).toEqual(["desktop"]);
    expect(channelsFor(DEFAULT_NOTE_SETTINGS, "alert", [])).toEqual([]);
  });

  it("holds back everything but liquidation risk on do not disturb", () => {
    const dnd = { ...DEFAULT_NOTE_SETTINGS, dnd: true };
    expect(channelsFor(dnd, "fill")).toEqual([]);
    expect(channelsFor(dnd, "alert")).toEqual([]);
    expect(channelsFor(dnd, "risk")).toEqual(["toast", "desktop", "sound"]);
  });

  it("keeps the newest notifications, capped", () => {
    let notes: AppNote[] = [];
    for (let i = 0; i < MAX_NOTES + 5; i++) notes = withNote(notes, note(i));
    expect(notes).toHaveLength(MAX_NOTES);
    expect(notes[0]?.id).toBe(String(MAX_NOTES + 4));
  });

  it("reads saved settings, filling gaps with the defaults", () => {
    expect(loadNoteSettings(store())).toEqual(DEFAULT_NOTE_SETTINGS);
    const saved = loadNoteSettings(
      store({
        "pd.notifications.settings": JSON.stringify({
          dnd: true,
          types: { fill: { desktop: false, sound: "yes" }, bogus: { toast: false } },
        }),
      }),
    );
    expect(saved.dnd).toBe(true);
    expect(saved.types.fill).toEqual({ toast: true, desktop: false, sound: true });
    expect(saved.types.alert).toEqual(DEFAULT_NOTE_SETTINGS.types.alert);
  });

  it("carries over the old single switch", () => {
    const off = loadNoteSettings(store({ "pd.notifications": "off" }));
    expect(Object.values(off.types).every((t) => !t.desktop)).toBe(true);
    expect(off.types.fill.toast).toBe(true);
  });

  it("drops unreadable entries from the log", () => {
    const s = store({
      "pd.notifications.log": JSON.stringify([
        note(1),
        { id: 2 },
        "x",
        { ...note(3), type: "nope" },
      ]),
    });
    expect(loadNotes(s).map((n) => n.id)).toEqual(["1"]);
    expect(loadNotes(store({ "pd.notifications.log": "not json" }))).toEqual([]);
  });
});
