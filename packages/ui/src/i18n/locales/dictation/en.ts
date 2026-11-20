// Dictation: hold the right Option key, speak, let go. Kept apart from
// en.ts; spread into every locale's catalogue, so the other languages show
// it in English until it's translated.
export const dictationEn = {
  "hotkeys.dictate": "Dictate: hold, speak, and let go to type it where the cursor is",
  "dictation.listening": "Listening…",
  "dictation.finishing": "Finishing…",
  "dictation.release": "Let go to type",
  "dictation.typing": "Typing",
  "dictation.noTarget": "Click into a text box first, then hold the key and speak.",
  "dictation.nothing": "Didn't catch anything.",
  "dictation.err.unsupported": "Dictation works on macOS only.",
  "dictation.err.speechDenied":
    "Speech recognition is off for PewterDesk: turn it on in System Settings › Privacy & Security › Speech Recognition.",
  "dictation.err.microphone":
    "The microphone didn't open ({detail}). Check System Settings › Privacy & Security › Microphone.",
  "dictation.err.unavailable":
    "Speech recognition isn't available for this Mac's language right now.",
  "dictation.err.notOnDevice":
    "This Mac can't recognize speech on the device in its language, and dictation never sends audio off it.",
  "dictation.err.heard": "Dictation stopped: {error}",
  "dictation.err.unknown": "Dictation didn't start.",
};
