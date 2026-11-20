import { t } from "@pewterdesk/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { DICTATE_CODE, HOLD_MS, isTypable, joinSpoken } from "../lib/dictation";

/** Where dictation stands, for the pill on screen. */
export type Dictation =
  | { state: "idle" }
  | { state: "listening"; heard: string }
  | { state: "finishing"; heard: string }
  /** Something to say for a moment: no text box, no permission, nothing heard. */
  | { state: "note"; text: string; warn?: boolean };

interface Heard {
  session: number;
  text: string;
  done: boolean;
  error?: string;
}

type RustError =
  | { kind: "unsupported" }
  | { kind: "speechDenied" }
  | { kind: "microphone"; detail: string }
  | { kind: "unavailable" }
  | { kind: "notOnDevice" };

function describe(e: unknown): string {
  const err = e as RustError | undefined;
  switch (err?.kind) {
    case "unsupported":
      return t("dictation.err.unsupported");
    case "speechDenied":
      return t("dictation.err.speechDenied");
    case "microphone":
      return t("dictation.err.microphone", { detail: err.detail });
    case "unavailable":
      return t("dictation.err.unavailable");
    case "notOnDevice":
      return t("dictation.err.notOnDevice");
    default:
      return typeof e === "string" ? e : t("dictation.err.unknown");
  }
}

/**
 * Types `spoken` into `el` where its cursor is, as if typed: through the
 * editing command, so React sees the change and Undo takes it back.
 */
function typeInto(el: HTMLElement, spoken: string) {
  el.focus();
  let before = "";
  let after = "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const from = el.selectionStart ?? el.value.length;
    const to = el.selectionEnd ?? from;
    before = el.value.slice(0, from);
    after = el.value.slice(to);
  } else {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE)
      before = (node.textContent ?? "").slice(0, sel?.anchorOffset);
  }
  const text = joinSpoken(before, spoken, after);
  if (!text) return;
  // `insertText` is deprecated in name only: it's still the one way to type
  // that goes through the browser's own editing (input events, undo).
  if (document.execCommand("insertText", false, text)) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Without it: set the value the way React's own listener notices.
    const from = el.selectionStart ?? el.value.length;
    const to = el.selectionEnd ?? from;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    setter?.call(el, el.value.slice(0, from) + text + el.value.slice(to));
    el.setSelectionRange(from + text.length, from + text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Hold the right Option key (a moment, so a tap or an Option shortcut does
 * nothing), speak, and let go: the words are typed where the cursor was in
 * the app, recognized on this Mac (`dictation.rs`). Any other key while it's
 * held, Esc, or leaving the window throws it away. Only in this window.
 */
export function useDictation(enabled = true): Dictation {
  const [now, setNow] = useState<Dictation>({ state: "idle" });
  const target = useRef<HTMLElement>(undefined);
  const session = useRef<number>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The key is down and nothing else has been pressed with it. */
  const held = useRef(false);
  const live = useRef(false);

  useEffect(() => {
    if (!enabled || !isTauri()) return;

    const note = (text: string, warn = false) => {
      setNow({ state: "note", text, warn });
      clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setNow({ state: "idle" }), 3500);
    };
    const drop = () => {
      clearTimeout(timer.current);
      held.current = false;
      if (live.current) {
        live.current = false;
        session.current = undefined;
        void invoke("dictation_cancel");
        setNow({ state: "idle" });
      }
    };
    const begin = async () => {
      const el = document.activeElement;
      if (!isTypable(el)) {
        note(t("dictation.noTarget"));
        return;
      }
      target.current = el;
      live.current = true;
      setNow({ state: "listening", heard: "" });
      try {
        const id = await invoke<number>("dictation_start");
        // Let go (or thrown away) before the microphone was even open.
        if (!live.current) {
          void invoke("dictation_cancel");
          return;
        }
        session.current = id;
        if (!held.current) {
          void invoke("dictation_stop");
          setNow({ state: "finishing", heard: "" });
        }
      } catch (e) {
        live.current = false;
        note(describe(e), true);
      }
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.code === DICTATE_CODE) {
        if (e.repeat || e.metaKey || e.ctrlKey || e.shiftKey) return;
        held.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => held.current && void begin(), HOLD_MS);
        return;
      }
      // Anything else while it's held: an Option shortcut, not dictation.
      if (held.current || live.current) {
        if (e.key === "Escape") e.preventDefault();
        drop();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== DICTATE_CODE) return;
      clearTimeout(timer.current);
      held.current = false;
      if (live.current && session.current !== undefined) {
        void invoke("dictation_stop");
        setNow((d) => ({ state: "finishing", heard: d.state === "listening" ? d.heard : "" }));
      }
    };

    let unlisten: (() => void) | undefined;
    let gone = false;
    listen<Heard>("dictation", ({ payload }) => {
      if (payload.session !== session.current) return;
      if (!payload.done) {
        setNow((d) =>
          d.state === "listening" || d.state === "finishing" ? { ...d, heard: payload.text } : d,
        );
        return;
      }
      live.current = false;
      session.current = undefined;
      const el = target.current;
      target.current = undefined;
      if (payload.text.trim() && el?.isConnected) {
        typeInto(el, payload.text);
        setNow({ state: "idle" });
      } else if (payload.error && !payload.text.trim()) {
        note(t("dictation.err.heard", { error: payload.error }), true);
      } else {
        note(t("dictation.nothing"));
      }
    }).then((off) => {
      if (gone) off();
      else unlisten = off;
    });

    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", drop);
    return () => {
      gone = true;
      unlisten?.();
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", drop);
      clearTimeout(noteTimer.current);
      drop();
    };
  }, [enabled]);

  return now;
}
