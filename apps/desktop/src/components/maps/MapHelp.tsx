import { type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuX } from "react-icons/lu";

// The Maps page's "?": what the view on screen shows, how it's worked
// out, how to read it, and what to keep in mind, in a dialog.

const PARTS = ["what", "how", "read", "caveats"] as const;

/** A "?" at the bottom right of the view; opens its explanation. */
export function MapHelp({
  view,
  title,
  vars,
}: {
  view: string;
  title: string;
  /** Filled into the explanation: `venue`, whose data the view reads. */
  vars?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);

  // showModal gives focus trapping, Escape and the backdrop.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="maps-help"
        aria-label={t("maphelp.open", { view: title })}
        title={t("maphelp.open", { view: title })}
        onClick={() => setOpen(true)}
      >
        ?
      </button>
      <dialog
        ref={ref}
        className="wallet-dialog maps-help-dialog"
        aria-labelledby="maps-help-title"
        onClose={() => setOpen(false)}
        // A click on the backdrop lands on the dialog element itself.
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        <header className="wallet-dialog-head">
          <h2 id="maps-help-title">{title}</h2>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("maphelp.close")}
            onClick={() => setOpen(false)}
          >
            <LuX size={17} aria-hidden />
          </button>
        </header>
        {open && (
          <div className="maps-help-body">
            {PARTS.map((part) => (
              <section key={part}>
                <h3 className="maps-help-part">{t(`maphelp.part.${part}` as MessageKey)}</h3>
                <p>{t(`maphelp.${view}.${part}` as MessageKey, vars)}</p>
              </section>
            ))}
            <p className="maps-help-foot">{t("maphelp.foot")}</p>
          </div>
        )}
      </dialog>
    </>
  );
}
