import { t } from "@pewterdesk/ui";
import { LuCircleAlert, LuMic } from "react-icons/lu";
import type { Dictation } from "../hooks/useDictation";

/**
 * Dictation on screen, at the foot of the window: listening (with what it
 * has heard so far), finishing, or a word about why not. It shows only.
 */
export function DictationPill({ dictation: d }: { dictation: Dictation }) {
  if (d.state === "idle") return null;
  if (d.state === "note") {
    return (
      <output className={`dictation-pill note${d.warn ? " warn" : ""}`}>
        {d.warn ? <LuCircleAlert size={15} aria-hidden /> : <LuMic size={15} aria-hidden />}
        <span>{d.text}</span>
      </output>
    );
  }
  // The newest words, as they're said: an older start gives way.
  const heard = d.heard.length > 70 ? `…${d.heard.slice(-69).trimStart()}` : d.heard;
  return (
    <output className={`dictation-pill ${d.state}`} aria-live="polite">
      <span className="dictation-mic">
        <LuMic size={15} aria-hidden />
      </span>
      <span className="dictation-text">
        {heard ? (
          heard
        ) : (
          <em>{d.state === "listening" ? t("dictation.listening") : t("dictation.finishing")}</em>
        )}
      </span>
      <kbd>{d.state === "listening" ? t("dictation.release") : t("dictation.typing")}</kbd>
    </output>
  );
}
