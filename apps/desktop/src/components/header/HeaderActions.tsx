import {
  currentLocale,
  IconButton,
  languageName,
  OptionsMenu,
  StarButton,
  shortAddress,
  t,
} from "@pewterdesk/ui";
import type { ReactNode } from "react";
import {
  LuGlobe,
  LuKeyRound,
  LuLayoutGrid,
  LuPalette,
  LuSettings,
  LuVolume2,
  LuVolumeX,
  LuWallet,
  LuZap,
} from "react-icons/lu";
import type { Theme } from "../../hooks/useAppearance";
import type { VenueAccount } from "../../lib/account";
import { switchLanguage } from "../../lib/language";
import { languageOptions, themeOptions } from "../preferences";
import { AccountAvatar } from "../wallet/AccountAvatar";

/** Lucide icons (via react-icons) at the header's icon size. */
const ICON_SIZE = 17;

interface HeaderActionsProps {
  /** Symbol of the market on screen, for the watchlist star; unset while loading. */
  marketSymbol: string | undefined;
  starred: boolean;
  onToggleStar: () => void;
  quickTradeOpen: boolean;
  onToggleQuickTrade: () => void;
  editing: boolean;
  onToggleLayout: () => void;
  soundOn: boolean;
  onSound: (on: boolean) => void;
  /** The alerts bell and its popover. */
  alerts: ReactNode;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  address: string | undefined;
  /** The active account's name, for the chip's tooltip. */
  accountName?: string;
  /** The active account, whose picture the chip shows. */
  account?: Pick<VenueAccount, "venue" | "id">;
  /** Marks a demo account (demo funds) on the chip. */
  demo?: boolean;
  /** How the venue on screen connects, which the button names. */
  connectAuth: "wallet" | "apiKey";
  onOpenWallet: () => void;
}

/** The header's right end: watchlist star, layout, sound, alerts, settings, language, theme and the wallet. */
export function HeaderActions({
  marketSymbol,
  starred,
  onToggleStar,
  quickTradeOpen,
  onToggleQuickTrade,
  editing,
  onToggleLayout,
  soundOn,
  onSound,
  alerts,
  settingsOpen,
  onToggleSettings,
  theme,
  onTheme,
  address,
  accountName,
  account,
  demo,
  connectAuth,
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
        label={t("action.quickTrade")}
        pressed={quickTradeOpen}
        onClick={onToggleQuickTrade}
      >
        <LuZap size={ICON_SIZE} aria-hidden />
      </IconButton>
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
      {alerts}
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
          // Just the picture; the name and address are in the tooltip.
          title={t("wallet.connectedAddress", {
            address: accountName ? `${accountName} · ${address}` : address,
          })}
          aria-label={t("wallet.connectedAddress", {
            address: accountName ? `${accountName} · ${address}` : address,
          })}
          onClick={onOpenWallet}
        >
          {account ? (
            <AccountAvatar account={account} size={34} live />
          ) : (
            <>
              <span className="pd-live-dot" data-live aria-hidden />
              <span className="pd-num">{shortAddress(address)}</span>
            </>
          )}
          {demo && <span className="app-demo-tag">{t("accounts.demo")}</span>}
        </button>
      ) : (
        <button type="button" className="app-connect" onClick={onOpenWallet}>
          {connectAuth === "apiKey" ? (
            <LuKeyRound size={ICON_SIZE} aria-hidden />
          ) : (
            <LuWallet size={ICON_SIZE} aria-hidden />
          )}
          {t(connectAuth === "apiKey" ? "apiKey.connect" : "wallet.connect")}
        </button>
      )}
    </div>
  );
}
