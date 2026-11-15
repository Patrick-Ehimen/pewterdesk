/**
 * The app's sounds: short phrases made on the spot (no audio files), for
 * things that happen because of the user or to their account. Silent when
 * sounds are switched off (the header's speaker button, or Settings), and as
 * loud as the volume set in Settings > Notifications.
 */

/** What a sound is for, where the call site says so; each has its own phrase. */
export type SoundKind =
  /** An order went to the venue. */
  | "order"
  /** A fill, or a position opened, closed or resized. */
  | "fill"
  /** Something was saved: a TP or SL, the leverage, an alert, a setting. */
  | "saved"
  /** An order was cancelled. */
  | "cancel"
  /** Something was refused. */
  | "error"
  /** A market alert fired, or a position is close to liquidation. */
  | "alert";

/**
 * Every sound a notification can be given in Settings: the call sites' own
 * phrases, and more to tell alerts apart by ear.
 */
export const SOUNDS = [
  "order",
  "fill",
  "alert",
  "chime",
  "bell",
  "marimba",
  "ping",
  "pulse",
  "rise",
  "fall",
  "sonar",
  "beacon",
  "siren",
  "none",
] as const;
export type SoundId = (typeof SOUNDS)[number];

/** Sounds that say what happened whatever a notification's sound is set to. */
export const FIXED_SOUNDS: readonly SoundKind[] = ["saved", "cancel", "error"];

/** A note: its pitch (Hz), when it starts and how long it rings (seconds). */
type Note = [frequency: number, start: number, length: number];

interface Phrase {
  notes: Note[];
  /** The tone's colour: sine is soft, triangle rounder, square buzzier (kept quiet). */
  wave?: OscillatorType;
  /** Loudness against the others, so each lands about the same. */
  gain?: number;
}

const PHRASES: Record<SoundId | SoundKind, Phrase> = {
  order: {
    notes: [
      [660, 0, 0.09],
      [880, 0.08, 0.14],
    ],
  },
  fill: {
    notes: [
      [784, 0, 0.08],
      [988, 0.07, 0.08],
      [1175, 0.14, 0.18],
    ],
  },
  saved: { notes: [[740, 0, 0.12]] },
  cancel: {
    notes: [
      [587, 0, 0.09],
      [440, 0.08, 0.14],
    ],
  },
  error: {
    notes: [
      [220, 0, 0.12],
      [196, 0.13, 0.2],
    ],
  },
  alert: {
    notes: [
      [932, 0, 0.1],
      [932, 0.16, 0.1],
      [1245, 0.32, 0.2],
    ],
  },
  chime: {
    notes: [
      [1046, 0, 0.5],
      [1318, 0.12, 0.5],
      [1568, 0.24, 0.7],
    ],
  },
  bell: {
    notes: [
      [880, 0, 0.9],
      [1760, 0, 0.5],
    ],
    gain: 0.8,
  },
  marimba: {
    notes: [
      [523, 0, 0.16],
      [659, 0.11, 0.16],
      [784, 0.22, 0.16],
      [1046, 0.33, 0.26],
    ],
    wave: "triangle",
  },
  ping: { notes: [[1480, 0, 0.25]] },
  pulse: {
    notes: [
      [740, 0, 0.07],
      [740, 0.11, 0.07],
      [740, 0.22, 0.07],
      [740, 0.33, 0.07],
    ],
    wave: "triangle",
  },
  rise: {
    notes: [
      [440, 0, 0.1],
      [554, 0.09, 0.1],
      [659, 0.18, 0.1],
      [880, 0.27, 0.22],
    ],
  },
  fall: {
    notes: [
      [880, 0, 0.1],
      [659, 0.09, 0.1],
      [554, 0.18, 0.1],
      [440, 0.27, 0.22],
    ],
  },
  sonar: {
    notes: [
      [1200, 0, 0.6],
      [1200, 0.7, 0.35],
    ],
    gain: 0.9,
  },
  beacon: {
    notes: [
      [660, 0, 0.18],
      [990, 0.2, 0.18],
      [660, 0.4, 0.18],
      [990, 0.6, 0.24],
    ],
    wave: "triangle",
  },
  siren: {
    notes: [
      [700, 0, 0.16],
      [1050, 0.16, 0.16],
      [700, 0.32, 0.16],
      [1050, 0.48, 0.16],
      [700, 0.64, 0.22],
    ],
    wave: "square",
    gain: 0.35,
  },
  none: { notes: [] },
};

/** The loudest a note gets at full volume, of full scale. */
const PEAK = 0.24;
const SOUND_KEY = "pd.sound";
const VOLUME_KEY = "pd.sound.volume";
/** Where the volume starts: as loud as sounds were before there was a setting. */
export const DEFAULT_VOLUME = 50;

let context: AudioContext | undefined;

/** Whether sounds are on (they are until switched off). */
export function soundsOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

/** The volume, 0 to 100. */
export function soundVolume(): number {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(saved)
      ? Math.min(100, Math.max(0, Math.round(saved)))
      : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function setSoundVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.min(100, Math.max(0, Math.round(volume)))));
  } catch {
    // Storage off: the volume lasts this session only.
  }
}

/**
 * Plays a sound, if sounds are on; `preview` plays it even when they're off
 * (the Settings page's play buttons). Never throws: a sound is a nicety.
 */
export function playSound(sound: SoundId | SoundKind, preview = false): void {
  if (!preview && !soundsOn()) return;
  const phrase = PHRASES[sound];
  const volume = soundVolume() / 100;
  if (!phrase || phrase.notes.length === 0 || volume <= 0) return;
  try {
    context ??= new AudioContext();
    // Browsers hold audio until the page has been interacted with.
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    const peak = PEAK * volume * (phrase.gain ?? 1);
    for (const [frequency, start, length] of phrase.notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = phrase.wave ?? "sine";
      oscillator.frequency.value = frequency;
      // A quick rise and a fade, so notes don't click.
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(peak, now + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + length + 0.02);
    }
  } catch {
    // No audio device, or audio not allowed: carry on silently.
  }
}
