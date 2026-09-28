import { t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { type AboutLink, type AppInfo, appClient } from "../../api/appClient";

/** Operating system names as their makers write them. */
const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
/** Rust's architecture names as people know them. */
const ARCH_NAME: Record<string, string> = { aarch64: "arm64", x86_64: "x64" };

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
  /** The wordmark for the current theme. */
  logoSrc: string;
}

/**
 * About pewterdesk, after the design: the wordmark, this build, the licence,
 * where keys and data live, and links to the project. The design's update
 * card waits for an updater; this says so instead of pretending.
 */
export function AboutDialog({ open, onClose, logoSrc }: AboutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<AppInfo>();
  const [linkError, setLinkError] = useState(false);

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setLinkError(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || info) return;
    appClient.info().then(setInfo, () => {});
  }, [open, info]);

  const build = info
    ? [
        `v${info.version}`,
        t(info.debug ? "about.devBuild" : "about.releaseBuild"),
        `${OS_NAME[info.os] ?? info.os} ${ARCH_NAME[info.arch] ?? info.arch}`,
      ].join(" · ")
    : "—";

  const link = (id: AboutLink, label: string) => (
    <button
      type="button"
      className="about-link"
      onClick={() =>
        appClient.openLink(id).then(
          () => setLinkError(false),
          () => setLinkError(true),
        )
      }
    >
      {label}
    </button>
  );

  return (
    <dialog
      ref={ref}
      className="wallet-dialog about-dialog"
      aria-label={t("nav.about")}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="about-head">
        <img className="about-logo" src={logoSrc} alt="pewterdesk" />
        <p className="about-build pd-num">{build}</p>
        <p className="pd-muted">{t("about.openSource")}</p>
      </header>

      <dl className="about-facts">
        <div>
          <dt>{t("about.updates")}</dt>
          <dd>{t("about.updatesValue")}</dd>
        </div>
        <div>
          <dt>{t("about.keys")}</dt>
          <dd>{t("about.keysValue")}</dd>
        </div>
        <div>
          <dt>{t("about.data")}</dt>
          <dd>{t("about.dataValue")}</dd>
        </div>
      </dl>

      <footer className="about-links">
        {link("repository", t("about.github"))}
        {link("issues", t("about.reportBug"))}
        {link("license", t("about.licenses"))}
        <span className="app-spacer" />
        <button type="button" className="about-link" onClick={onClose}>
          {t("about.close")}
        </button>
      </footer>
      {linkError && (
        <p className="about-error" role="alert">
          {t("about.linkFailed")}
        </p>
      )}
    </dialog>
  );
}
