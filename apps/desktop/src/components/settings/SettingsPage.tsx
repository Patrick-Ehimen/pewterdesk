import {
  currentLocale,
  type Locale,
  type MessageKey,
  type RowMode,
  Switch,
  shortAddress,
  t,
} from "@pewterdesk/ui";
import { useState } from "react";
import { LuArrowLeft, LuKeyRound } from "react-icons/lu";
import type { MarketColors, Theme } from "../../hooks/useAppearance";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { switchLanguage } from "../../lib/language";
import {
  languageOptions,
  marketColorOptions,
  ROW_MODES,
  rowModeOptions,
  themeOptions,
  VIEW_KEYS,
} from "../preferences";
import {
  ChoiceCards,
  ConfirmButton,
  DoneButton,
  GroupLabel,
  SectionHead,
  SettingRow,
} from "./parts";

type SectionId =
  | "general"
  | "wallets"
  | "trading"
  | "hotkeys"
  | "notifications"
  | "appearance"
  | "network"
  | "advanced";

/** In the design's order. `soon` sections aren't built yet and only say what's coming. */
const SECTIONS: { id: SectionId; soon?: MessageKey }[] = [
  { id: "general" },
  { id: "wallets" },
  { id: "trading", soon: "settings.trading.desc" },
  { id: "hotkeys", soon: "settings.hotkeys.desc" },
  { id: "notifications", soon: "settings.notifications.desc" },
  { id: "appearance" },
  { id: "network", soon: "settings.network.desc" },
  { id: "advanced" },
];

const navLabel = (id: SectionId) => t(`settings.nav.${id}`);

export interface SettingsPageProps {
  onClose: () => void;
  soundOn: boolean;
  onSound: (on: boolean) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  marketColors: MarketColors;
  onMarketColors: (colors: MarketColors) => void;
  address: string | undefined;
  onWatch: (address: string | undefined) => void;
  onOpenWallet: () => void;
  onResetLayout: () => void;
  onClearWatchlist: () => void;
}

/** Full-page settings, after the design's settings screen. */
export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SectionId>("general");
  const current = SECTIONS.find((s) => s.id === section);

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.title")}>
        <button type="button" className="settings-back" onClick={props.onClose}>
          <LuArrowLeft size={15} aria-hidden />
          {t("settings.back")}
        </button>
        <h1>{t("settings.title")}</h1>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                aria-current={s.id === section ? "page" : undefined}
                onClick={() => setSection(s.id)}
              >
                {navLabel(s.id)}
                {s.soon && <span className="settings-soon">{t("settings.soon")}</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="settings-main">
        {current?.soon ? (
          <>
            <SectionHead title={navLabel(section)} description={t(current.soon)} />
            <p className="settings-empty">{t("settings.comingSoon")}</p>
          </>
        ) : section === "general" ? (
          <GeneralSection {...props} />
        ) : section === "wallets" ? (
          <WalletsSection {...props} />
        ) : section === "appearance" ? (
          <AppearanceSection {...props} />
        ) : (
          <AdvancedSection {...props} />
        )}
      </main>
    </div>
  );
}

function GeneralSection({ soundOn, onSound }: SettingsPageProps) {
  const locale = currentLocale();
  return (
    <>
      <SectionHead title={navLabel("general")} description={t("settings.general.desc")} />
      <GroupLabel>{t("menu.language")}</GroupLabel>
      <p className="settings-help">{t("settings.languageHelp")}</p>
      <ChoiceCards<Locale>
        legend={t("menu.language")}
        options={languageOptions()}
        value={locale}
        onChange={(next) => next !== locale && switchLanguage(next)}
        columns={4}
      />
      <GroupLabel>{t("settings.sounds")}</GroupLabel>
      <SettingRow title={t("settings.sounds")} help={t("settings.soundsHelp")}>
        <Switch checked={soundOn} onChange={onSound} label={t("settings.sounds")} />
      </SettingRow>
    </>
  );
}

function WalletsSection({ address, onWatch, onOpenWallet }: SettingsPageProps) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <SectionHead title={navLabel("wallets")} description={t("settings.wallets.desc")} />
      <div className="settings-cards-2">
        <section className="settings-panel" aria-labelledby="settings-watched">
          <GroupLabel>
            <span id="settings-watched">{t("settings.watched")}</span>
          </GroupLabel>
          {address ? (
            <>
              <div className="settings-identity">
                <span className="pd-live-dot" data-live aria-hidden />
                <div>
                  <strong className="pd-num" title={address}>
                    {shortAddress(address)}
                  </strong>
                  <span>{t("settings.watchedHelp")}</span>
                </div>
              </div>
              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-button"
                  onClick={() =>
                    navigator.clipboard.writeText(address).then(
                      () => setCopied(true),
                      () => {},
                    )
                  }
                  onBlur={() => setCopied(false)}
                >
                  {copied ? t("settings.copied") : t("settings.copyAddress")}
                </button>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => onWatch(undefined)}
                >
                  {t("wallet.stopWatching")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="settings-help">{t("settings.noWatched")}</p>
              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-button"
                  data-primary
                  onClick={onOpenWallet}
                >
                  {t("wallet.connect")}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="settings-panel" aria-labelledby="settings-keys">
          <GroupLabel>
            <span id="settings-keys">{t("settings.keys")}</span>
          </GroupLabel>
          <div className="settings-identity">
            <span className="settings-icon" aria-hidden>
              <LuKeyRound size={16} />
            </span>
            <div>
              <strong>{t("settings.keysNone")}</strong>
              <span>{t("settings.keysHelp")}</span>
            </div>
          </div>
        </section>
      </div>

      <GroupLabel>{t("settings.safeguards")}</GroupLabel>
      <p className="settings-help">{t("settings.safeguardsHelp")}</p>
    </>
  );
}

function AppearanceSection({ theme, onTheme, marketColors, onMarketColors }: SettingsPageProps) {
  const [bookMode, setBookMode] = useStoredChoice<RowMode>(VIEW_KEYS.book, ROW_MODES, "table");
  const [tradesMode, setTradesMode] = useStoredChoice<RowMode>(
    VIEW_KEYS.trades,
    ROW_MODES,
    "table",
  );
  return (
    <>
      <SectionHead title={navLabel("appearance")} description={t("settings.appearance.desc")} />
      <GroupLabel>{t("menu.theme")}</GroupLabel>
      <ChoiceCards<Theme>
        legend={t("menu.theme")}
        options={themeOptions()}
        value={theme}
        onChange={(next) => next !== theme && onTheme(next)}
        columns={3}
      />
      <GroupLabel>{t("settings.marketColors")}</GroupLabel>
      <ChoiceCards<MarketColors>
        legend={t("settings.marketColors")}
        options={marketColorOptions()}
        value={marketColors}
        onChange={onMarketColors}
        columns={2}
      />
      <GroupLabel>{t("settings.bookView")}</GroupLabel>
      <ChoiceCards<RowMode>
        legend={t("settings.bookView")}
        options={rowModeOptions()}
        value={bookMode}
        onChange={setBookMode}
        columns={2}
      />
      <GroupLabel>{t("settings.tradesView")}</GroupLabel>
      <ChoiceCards<RowMode>
        legend={t("settings.tradesView")}
        options={rowModeOptions()}
        value={tradesMode}
        onChange={setTradesMode}
        columns={2}
      />
    </>
  );
}

/** Clears every preference this app keeps in browser storage (all "pd." keys), then reloads. */
function resetAllPreferences() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("pd."));
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage unavailable: there's nothing stored to reset.
  }
  window.location.reload();
}

function AdvancedSection({ onResetLayout, onClearWatchlist }: SettingsPageProps) {
  return (
    <>
      <SectionHead title={navLabel("advanced")} description={t("settings.advanced.desc")} />
      <SettingRow title={t("settings.resetLayout")} help={t("settings.resetLayoutHelp")}>
        <DoneButton onClick={onResetLayout}>{t("settings.resetLayout")}</DoneButton>
      </SettingRow>
      <SettingRow title={t("settings.clearWatchlist")} help={t("settings.clearWatchlistHelp")}>
        <DoneButton onClick={onClearWatchlist}>{t("settings.clearWatchlist")}</DoneButton>
      </SettingRow>
      <div className="settings-danger">
        <SettingRow title={t("settings.resetAll")} help={t("settings.resetAllHelp")}>
          <ConfirmButton onConfirm={resetAllPreferences}>
            {t("settings.resetAllButton")}
          </ConfirmButton>
        </SettingRow>
      </div>
    </>
  );
}
