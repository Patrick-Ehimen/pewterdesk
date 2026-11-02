import { dateFormat, formatNumber, t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { type AboutLink, type AppInfo, appClient, type UpdateStatus } from "../../api/appClient";
import { useUpdates } from "../../hooks/useUpdates";
import { AppLogo } from "../header/AppLogo";

/** Operating system names as their makers write them. */
const OS_NAME: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
/** Rust's architecture names as people know them. */
const ARCH_NAME: Record<string, string> = { aarch64: "arm64", x86_64: "x64" };

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * About pewterdesk, after the design: the wordmark, this build, the licence,
 * where keys and data live, and links to the project. A downloaded update
 * shows as a card, installed only from its Restart button (`updater.rs`).
 */
export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<AppInfo>();
  const [linkError, setLinkError] = useState(false);
  const updates = useUpdates();
  const [installError, setInstallError] = useState(false);

  // Drive the native dialog from `open`: showModal gives focus trapping,
  // Escape and the backdrop for free.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setLinkError(false);
      setInstallError(false);
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
    : "-";

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
        <AppLogo className="about-logo" />
        <p className="about-build pd-num">{build}</p>
        <p className="pd-muted">{t("about.openSource")}</p>
      </header>

      {updates?.state === "ready" && (
        <section className="about-update">
          <div className="about-update-head">
            <strong>{t("about.updateReady", { version: updates.version })}</strong>
            <span className="about-update-tag">{t("about.updateVerified")}</span>
            <span className="app-spacer" />
            <span className="pd-num pd-muted">{megabytes(updates.size)}</span>
          </div>
          {updates.notes && <p className="about-update-notes">{updates.notes}</p>}
          <div className="about-update-actions">
            <button
              type="button"
              className="about-update-restart"
              onClick={() => appClient.installUpdate().catch(() => setInstallError(true))}
            >
              {t("about.updateRestart")}
            </button>
            <span className="app-spacer" />
            {link("releases", t("about.updateNotes"))}
          </div>
          <p className="pd-muted about-update-safe">{t("about.updateSafe")}</p>
          {installError && (
            <p className="about-update-error" role="alert">
              {t("about.updateInstallFailed")}
            </p>
          )}
        </section>
      )}

      <dl className="about-facts">
        <div>
          <dt>{t("about.updates")}</dt>
          <dd className="about-update-status">
            {updateText(updates)}
            {updates?.enabled &&
              updates.state !== "checking" &&
              updates.state !== "downloading" && (
                <button
                  type="button"
                  className="about-link"
                  onClick={() => void appClient.checkForUpdate().catch(() => {})}
                >
                  {t("about.updateCheck")}
                </button>
              )}
          </dd>
        </div>
        {updates?.lastChecked !== undefined && (
          <div>
            <dt>{t("about.updateLastChecked")}</dt>
            <dd className="pd-num">{checkedAt(updates.lastChecked)}</dd>
          </div>
        )}
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

const megabytes = (bytes: number) => `${formatNumber(bytes / 1_048_576, 1)} MB`;

const checkedAt = (time: number) =>
  dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(new Date(time));

/** Where updates stand, in a few words. */
function updateText(status: UpdateStatus | undefined): string {
  if (!status?.enabled) return t("about.updatesDev");
  switch (status.state) {
    case "idle":
      return t("about.updatesIdle");
    case "checking":
      return t("about.updatesChecking");
    case "upToDate":
      return t("about.updatesCurrent");
    case "downloading": {
      const pct = status.total ? Math.floor((status.received / status.total) * 100) : undefined;
      return pct === undefined
        ? t("about.updatesDownloading", { version: status.version })
        : t("about.updatesDownloadingPct", { version: status.version, pct: String(pct) });
    }
    case "ready":
      return t("about.updateReady", { version: status.version });
    case "failed":
      return t("about.updatesFailed");
  }
}
