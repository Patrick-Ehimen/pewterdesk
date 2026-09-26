import { type MessageKey, t } from "@pewterdesk/ui";

/**
 * A page that's in the navigation but not built yet: its title and subtitle
 * as in the design, and a plain description of what's coming instead of
 * made-up data.
 */
export function ComingSoonPage({
  title,
  subtitle,
  description,
}: {
  title: MessageKey;
  subtitle: MessageKey;
  description: MessageKey;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t(title)}</h1>
        <span>{t(subtitle)}</span>
      </header>
      <div className="page-soon">
        <span className="settings-soon">{t("settings.comingSoon")}</span>
        <p>{t(description)}</p>
      </div>
    </div>
  );
}
