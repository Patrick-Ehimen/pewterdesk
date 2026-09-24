/// <reference path="./assets.d.ts" />
// Brand assets as URL strings (bundled by the consuming app's Vite build).
// Variants are named for the background they sit on: `darkBg` for dark UIs,
// `lightBg` for light ones. See the logo kit rules before recoloring anything.

import appleTouchIcon from "./favicon/apple-touch-icon.png";
import faviconIco from "./favicon/favicon.ico";
import faviconSvg from "./favicon/favicon.svg";
import appIconDark from "./icon/pewterdesk-icon-dark-1024.png";
import horizontalDarkBg from "./logo/pewterdesk-horizontal-dark-bg.svg";
import horizontalLightBg from "./logo/pewterdesk-horizontal-light-bg.svg";
import markDarkBg from "./logo/pewterdesk-mark-dark-bg.svg";
import markLightBg from "./logo/pewterdesk-mark-light-bg.svg";

export const logo = {
  /** Symbol + name side by side — the default logo. Min width 96px. */
  horizontal: { darkBg: horizontalDarkBg, lightBg: horizontalLightBg },
  /** Symbol only, for tight spaces. Min size 16px. */
  mark: { darkBg: markDarkBg, lightBg: markLightBg },
} as const;

/** 1024px dark app icon — also the source for `make icons`. */
export const appIcon = appIconDark;

export const favicon = {
  /** Switches light/dark itself via prefers-color-scheme. */
  svg: faviconSvg,
  ico: faviconIco,
  appleTouch: appleTouchIcon,
} as const;
