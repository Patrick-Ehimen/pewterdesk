// The Download page's copy. The installer kinds are the ones the release
// workflow attaches (.github/workflows/release.yml).
import { REPO_URL, VERSION } from "../site";

export const head = {
  label: "Download",
  title: "Get the desk.",
  lede: `Version ${VERSION}, a pre-release of an app still in development. Free, open source, and yours to build.`,
};

export const installers = {
  label: "§ 01 — Installers",
  rows: [
    { platform: "macOS", detail: "Apple Silicon", files: ".dmg", needs: "macOS 13 or later" },
    { platform: "macOS", detail: "Intel", files: ".dmg", needs: "macOS 13 or later" },
    { platform: "Windows", detail: "x64", files: ".exe · .msi", needs: "Windows 10 or later" },
    {
      platform: "Linux",
      detail: "x64",
      files: ".AppImage · .deb · .rpm",
      needs: "WebKitGTK 4.1 (Ubuntu 22.04+)",
    },
  ],
  button: "Open the releases page",
  note: "Installers are attached to each release on GitHub.",
} as const;

export const firstRun = {
  label: "§ 02 — First run",
  title: "From install to a first order.",
  steps: [
    {
      title: "Open it and look around",
      body: "Charts, books and the maps work straight away. Market data is public, so nothing needs connecting to read it.",
    },
    {
      title: "Connect an account",
      body: "A Bybit API key, or a Hyperliquid or Aster wallet. You'll need your own; pewterdesk doesn't create venue accounts.",
    },
    {
      title: "Start on demo",
      body: "A Bybit Demo Trading key trades with demo funds on the same screen. Learn the ticket there first.",
    },
    {
      title: "Go live when you choose",
      body: "Live trading is off for every account until you turn it on in that account's details.",
    },
  ],
} as const;

export const source = {
  label: "§ 03 — From source",
  title: "Build the thing that signs your orders.",
  body: "The whole app is in one repository. You need Node 22.12 or later, pnpm 9 and a Rust toolchain.",
  commands: [`git clone ${REPO_URL}`, "cd pewterdesk && make install", "make dev"],
  bundle: "make bundle",
  bundleNote: "builds an installer for your own platform.",
};
