import { t } from "@pewterdesk/ui";
import type { IconType } from "react-icons";
import { LuBookOpen, LuLifeBuoy, LuScale } from "react-icons/lu";
import { type AboutLink, appClient } from "../api/appClient";

export type Connection = "online" | "connecting" | "offline";

const LABEL = {
  online: "status.online",
  connecting: "status.connecting",
  offline: "status.offline",
} as const;

const LINKS: {
  link: AboutLink;
  label: "footer.docs" | "footer.support" | "footer.license";
  Icon: IconType;
}[] = [
  { link: "repository", label: "footer.docs", Icon: LuBookOpen },
  { link: "issues", label: "footer.support", Icon: LuLifeBuoy },
  { link: "license", label: "footer.license", Icon: LuScale },
];

/**
 * The app's bottom bar: whether the venue's feeds are live, and links to
 * the project. Links open in the system browser through the About box's
 * fixed-link opener, so the page can't open anything else.
 */
export function StatusBar({ connection, venue }: { connection: Connection; venue: string }) {
  return (
    <footer className="app-status">
      <span
        className="app-status-pill"
        data-state={connection}
        role="status"
        title={t("status.hint", { venue })}
      >
        <span
          className="pd-live-dot"
          data-live={connection === "online" || undefined}
          aria-hidden
        />
        {t(LABEL[connection])}
      </span>
      <span className="app-spacer" />
      <nav className="app-status-links" aria-label={t("status.links")}>
        {LINKS.map(({ link, label, Icon }) => (
          <button key={link} type="button" onClick={() => appClient.openLink(link).catch(() => {})}>
            <Icon size={13} aria-hidden />
            {t(label)}
          </button>
        ))}
      </nav>
    </footer>
  );
}
