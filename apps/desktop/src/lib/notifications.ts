// The app's notifications, through one door: everything worth telling the
// user (an order, a fill, a position change, a fired alert, a liquidation
// warning) goes to `notifyEvent`, which records it in the notification
// centre and delivers it where the settings say: a toast in the app, a
// desktop notification when the app isn't in front, a sound. Kept on this
// machine in browser storage; nothing here leaves it.

import { type ToastTone, toast } from "@pewterdesk/ui";
import { desktopNotify } from "./notify";
import { playSound, type SoundKind } from "./sound";

/** What a notification is about; each has its own settings. */
export const NOTE_TYPES = ["order", "fill", "position", "alert", "risk"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Where a notification can be delivered. */
export const NOTE_CHANNELS = ["toast", "desktop", "sound"] as const;
export type NoteChannel = (typeof NOTE_CHANNELS)[number];

/** One entry in the notification centre. */
export interface AppNote {
  id: string;
  type: NoteType;
  title: string;
  body?: string;
  tone: ToastTone;
  /** Milliseconds since the Unix epoch. */
  time: number;
  read: boolean;
  /** The market it's about, to jump to: a venue id and `Market::id`. */
  venue?: string;
  market?: string;
}

export interface NoteSettings {
  /** Do not disturb: everything is still recorded, but only liquidation risk is delivered. */
  dnd: boolean;
  types: Record<NoteType, Record<NoteChannel, boolean>>;
}

export const DEFAULT_NOTE_SETTINGS: NoteSettings = {
  dnd: false,
  types: {
    order: { toast: true, desktop: false, sound: true },
    fill: { toast: true, desktop: true, sound: true },
    position: { toast: true, desktop: true, sound: true },
    alert: { toast: true, desktop: true, sound: true },
    risk: { toast: true, desktop: true, sound: true },
  },
};

const LOG_KEY = "pd.notifications.log";
const SETTINGS_KEY = "pd.notifications.settings";
/** The old single switch for desktop notifications, read once to carry it over. */
const LEGACY_KEY = "pd.notifications";
/** Notifications kept in the centre; older ones drop off. */
export const MAX_NOTES = 200;

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isType = (v: unknown): v is NoteType => NOTE_TYPES.some((t) => t === v);
const isTone = (v: unknown): v is ToastTone =>
  v === "neutral" || v === "buy" || v === "sell" || v === "warn";

function isNote(v: unknown): v is AppNote {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    isType(v.type) &&
    typeof v.title === "string" &&
    (v.body === undefined || typeof v.body === "string") &&
    isTone(v.tone) &&
    typeof v.time === "number" &&
    typeof v.read === "boolean"
  );
}

export function loadNotes(store: Store | undefined = storage()): AppNote[] {
  try {
    const saved: unknown = JSON.parse(store?.getItem(LOG_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isNote).slice(0, MAX_NOTES) : [];
  } catch {
    return [];
  }
}

export function loadNoteSettings(store: Store | undefined = storage()): NoteSettings {
  const defaults = DEFAULT_NOTE_SETTINGS;
  try {
    const saved: unknown = JSON.parse(store?.getItem(SETTINGS_KEY) ?? "null");
    if (!isRecord(saved)) {
      // Before per-type settings there was one switch: off meant no desktop notifications.
      if (store?.getItem(LEGACY_KEY) !== "off") return defaults;
      const types = { ...defaults.types };
      for (const type of NOTE_TYPES) types[type] = { ...types[type], desktop: false };
      return { ...defaults, types };
    }
    const savedTypes = isRecord(saved.types) ? saved.types : {};
    const types = { ...defaults.types };
    for (const type of NOTE_TYPES) {
      const row = savedTypes[type];
      if (!isRecord(row)) continue;
      const next = { ...types[type] };
      for (const channel of NOTE_CHANNELS) {
        if (typeof row[channel] === "boolean") next[channel] = row[channel];
      }
      types[type] = next;
    }
    return { dnd: saved.dnd === true, types };
  } catch {
    return defaults;
  }
}

/**
 * Where a notification of `type` goes under `settings`. `only`, when
 * given, narrows it further (an alert's own choice of channels). Do not
 * disturb holds back everything but liquidation risk.
 */
export function channelsFor(
  settings: NoteSettings,
  type: NoteType,
  only?: readonly NoteChannel[],
): NoteChannel[] {
  if (settings.dnd && type !== "risk") return [];
  return NOTE_CHANNELS.filter((c) => settings.types[type][c] && (!only || only.includes(c)));
}

/** `notes` with a new one at the front, capped. */
export function withNote(notes: readonly AppNote[], note: AppNote): AppNote[] {
  return [note, ...notes].slice(0, MAX_NOTES);
}

// The live state: one store for the session, shared by whatever shows it.

let notes: readonly AppNote[] = loadNotes();
let settings: NoteSettings = loadNoteSettings();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}
function persist(key: string, value: unknown) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or off: it lasts this session.
  }
}

export function subscribeNotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const currentNotes = () => notes;
export const currentNoteSettings = () => settings;

export function setNoteSettings(next: NoteSettings) {
  settings = next;
  persist(SETTINGS_KEY, next);
  emit();
}

export function markNotesRead(ids?: readonly string[]) {
  const which = ids && new Set(ids);
  if (!notes.some((n) => !n.read && (!which || which.has(n.id)))) return;
  notes = notes.map((n) => (!n.read && (!which || which.has(n.id)) ? { ...n, read: true } : n));
  persist(LOG_KEY, notes);
  emit();
}

export function clearNotes() {
  if (notes.length === 0) return;
  notes = [];
  persist(LOG_KEY, notes);
  emit();
}

export interface NoteInput {
  type: NoteType;
  title: string;
  body?: string;
  tone?: ToastTone;
  /** The sound to play, if this type's sound is on. */
  sound?: SoundKind;
  venue?: string;
  market?: string;
  /** Narrows delivery to these channels (an alert's own choice). */
  only?: readonly NoteChannel[];
  /** Keeps it off the desktop even if the type allows it (something else shows it there). */
  noDesktop?: boolean;
}

/**
 * Records a notification and delivers it where the settings say. Callable
 * from anywhere, React or not.
 */
export function notifyEvent(input: NoteInput): void {
  const tone = input.tone ?? "neutral";
  const channels = channelsFor(settings, input.type, input.only);
  notes = withNote(notes, {
    id: crypto.randomUUID(),
    type: input.type,
    title: input.title,
    body: input.body,
    tone,
    time: Date.now(),
    // Shown as a toast in a window that's in front: seen. Otherwise it waits in the centre.
    read: channels.includes("toast") && document.hasFocus(),
    venue: input.venue,
    market: input.market,
  });
  persist(LOG_KEY, notes);
  emit();
  if (channels.includes("toast")) toast({ title: input.title, body: input.body, tone });
  if (channels.includes("desktop") && !input.noDesktop) {
    void desktopNotify(input.title, input.body);
  }
  if (channels.includes("sound") && input.sound) playSound(input.sound);
}
