import {
  currentLocale,
  IconButton,
  languageName,
  OptionsMenu,
  StarButton,
  shortAddress,
  t,
} from "@pewterdesk/ui";
import {
  LuGlobe,
  LuLayoutGrid,
  LuPalette,
  LuSettings,
  LuVolume2,
  LuVolumeX,
  LuWallet,
} from "react-icons/lu";
import type { Theme } from "../../hooks/useAppearance";
import { switchLanguage } from "../../lib/language";
import { languageOptions, themeOptions } from "../preferences";

/** Lucide icons (via react-icons) at the header's icon size. */
const ICON_SIZE = 17;

interface HeaderActionsProps {
  /** Symbol of the market on screen, for the watchlist star; unset while loading. */
  marketSymbol: string | undefined;
  starred: boolean;
  onToggleStar: () => void;
  editing: boolean;
  onToggleLayout: () => void;
  soundOn: boolean;
  onSound: (on: boolean) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  address: string | undefined;
  onOpenWallet: () => void;
}

/** The header's right end: watchlist star, layout, sound, settings, language, theme and the wallet. */
export function HeaderActions({
  marketSymbol,
  starred,
  onToggleStar,
  editing,
  onToggleLayout,
  soundOn,
  onSound,
  settingsOpen,
  onToggleSettings,
  theme,
  onTheme,
  address,
  onOpenWallet,
}: HeaderActionsProps) {
  const locale = currentLocale();

  return (
    <div className="app-actions">
      {marketSymbol && (
        <StarButton
          starred={starred}
          name={marketSymbol}
          size={ICON_SIZE}
          onToggle={onToggleStar}
        />
      )}
      <IconButton
        label={t(editing ? "action.doneLayout" : "action.editLayout")}
        pressed={editing}
        onClick={onToggleLayout}
      >
        <LuLayoutGrid size={ICON_SIZE} aria-hidden />
      </IconButton>
      <IconButton
        label={t(soundOn ? "action.mute" : "action.unmute")}
        onClick={() => onSound(!soundOn)}
      >
        {soundOn ? (
          <LuVolume2 size={ICON_SIZE} aria-hidden />
        ) : (
          <LuVolumeX size={ICON_SIZE} aria-hidden />
        )}
      </IconButton>
      <IconButton
        label={t(settingsOpen ? "settings.back" : "action.settings")}
        pressed={settingsOpen}
        onClick={onToggleSettings}
      >
        <LuSettings size={ICON_SIZE} aria-hidden />
      </IconButton>
      <OptionsMenu
        label={t("action.language", { language: languageName(locale) })}
        heading={t("menu.language")}
        icon={<LuGlobe size={ICON_SIZE} aria-hidden />}
        className=""
        columns={4}
        options={languageOptions()}
        value={locale}
        onChange={(next) => next !== locale && switchLanguage(next)}
      />
      <OptionsMenu
        label={t("action.theme", { theme: t(`theme.${theme}.name`) })}
        heading={t("menu.theme")}
        icon={<LuPalette size={ICON_SIZE} aria-hidden />}
        className=""
        columns={3}
        menuClassName="theme-menu"
        options={themeOptions()}
        value={theme}
        onChange={(next) => next !== theme && onTheme(next)}
      />

      {address ? (
        <button
          type="button"
          className="app-wallet-chip"
          title={t("wallet.watchingAddress", { address })}
          onClick={onOpenWallet}
        >
          <span className="pd-live-dot" data-live aria-hidden />
          <span className="pd-num">{shortAddress(address)}</span>
        </button>
      ) : (
        <button type="button" className="app-connect" onClick={onOpenWallet}>
          <LuWallet size={ICON_SIZE} aria-hidden />
          {t("wallet.connect")}
        </button>
      )}
    </div>
  );
}
