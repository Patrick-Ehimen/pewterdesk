import { useEffect, useRef, useSyncExternalStore } from "react";
import { LuX } from "react-icons/lu";
import { dateFormat, t } from "../../i18n";
import { clearToasts, dismissToast, subscribeToasts, toastsState } from "../../lib/toasts";

const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/**
 * The toast stack, bottom right: what `toast()` shows, newest last, each
 * dismissible, with "Clear all" once there are several. Render it once, at
 * the app's root.
 */
export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, toastsState);
  const ref = useRef<HTMLDivElement>(null);
  const newest = toasts.at(-1)?.id;

  // A popover, so it sits in the top layer with open dialogs; shown again
  // for each new toast, which puts it above a dialog opened since.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `newest` re-raises it for a new toast
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (toasts.length > 0) el.showPopover();
    } catch {
      // Not connected yet, or unsupported: it still shows, as a fixed box.
    }
  }, [newest, toasts.length > 0]);

  return (
    <div ref={ref} className="pd-toasts" popover="manual" role="log" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="pd-toast" data-tone={x.tone} role="status">
          <div className="pd-toast-head">
            <strong className="pd-toast-title">{x.title}</strong>
            <time className="pd-toast-time">{dateFormat(CLOCK).format(x.time)}</time>
            <button
              type="button"
              className="pd-toast-close"
              aria-label={t("toast.dismiss")}
              onClick={() => dismissToast(x.id)}
            >
              <LuX size={14} aria-hidden />
            </button>
          </div>
          {x.body && <p className="pd-toast-body">{x.body}</p>}
        </div>
      ))}
      {toasts.length > 1 && (
        <button type="button" className="pd-toasts-clear" onClick={clearToasts}>
          {t("toast.clearAll", { count: toasts.length })}
        </button>
      )}
    </div>
  );
}
