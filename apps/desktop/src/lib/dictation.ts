/**
 * Dictation's plain logic: what can be typed into, and how dictated words
 * join the text around the cursor. No React, no Tauri.
 */

/** The key held to dictate: the right-hand Option key (Alt elsewhere). */
export const DICTATE_CODE = "AltRight";

/** How long the key is held before listening starts, so a tap does nothing. */
export const HOLD_MS = 180;

const TEXT_INPUTS = new Set(["text", "search", "email", "url", ""]);

/** An element dictation can type into: a text field, a text area, or editable text. */
export function isTypable(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement)
    return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return el.isContentEditable;
}

/**
 * Dictated words as they should go in between `before` and `after`: a space
 * where they'd run into a word, and the first letter lowered in the middle
 * of a sentence (Apple capitalizes every dictation's first word), unless
 * it's "I" or an acronym.
 */
export function joinSpoken(before: string, spoken: string, after = ""): string {
  let text = spoken.trim();
  if (!text) return "";
  const prev = before.slice(-1);
  const midSentence = /[\p{L}\p{N},;:]/u.test(before.trimEnd().slice(-1) ?? "");
  const word = /^\p{Lu}(\p{Ll}|\s|$)/u.test(text) && !/^I(\s|'|’|$)/.test(text);
  if (midSentence && word) text = text[0]?.toLowerCase() + text.slice(1);
  if (before !== "" && !/\s/.test(prev)) text = ` ${text}`;
  if (after !== "" && !/^[\s.,;:!?)]/.test(after)) text = `${text} `;
  return text;
}
