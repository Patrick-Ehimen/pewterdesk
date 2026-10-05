/**
 * The app's sounds: short tones made on the spot (no audio files), for
 * things that happen because of the user or to their account. Silent when
 * sounds are switched off (the header's speaker button, or Settings).
 */

/** What a sound is for; each has its own short phrase. */
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

/** A note: its pitch (Hz), when it starts and how long it rings (seconds). */
type Note = [frequency: number, start: number, length: number];

const PHRASES: Record<SoundKind, Note[]> = {
  order: [
    [660, 0, 0.09],
    [880, 0.08, 0.14],
  ],
  fill: [
    [784, 0, 0.08],
    [988, 0.07, 0.08],
    [1175, 0.14, 0.18],
  ],
  saved: [[740, 0, 0.12]],
  cancel: [
    [587, 0, 0.09],
    [440, 0.08, 0.14],
  ],
  error: [
    [220, 0, 0.12],
    [196, 0.13, 0.2],
  ],
  alert: [
    [932, 0, 0.1],
    [932, 0.16, 0.1],
    [1245, 0.32, 0.2],
  ],
};

/** How loud the loudest point of a note is, of full scale. */
const VOLUME = 0.12;
const SOUND_KEY = "pd.sound";

let context: AudioContext | undefined;

/** Whether sounds are on (they are until switched off). */
export function soundsOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Plays `kind`'s phrase, if sounds are on. Never throws: a sound is a nicety. */
export function playSound(kind: SoundKind): void {
  if (!soundsOn()) return;
  try {
    context ??= new AudioContext();
    // Browsers hold audio until the page has been interacted with.
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    for (const [frequency, start, length] of PHRASES[kind]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // A quick rise and a fade, so notes don't click.
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(VOLUME, now + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + start);
      oscillator.stop(now + start + length + 0.02);
    }
  } catch {
    // No audio device, or audio not allowed: carry on silently.
  }
}
