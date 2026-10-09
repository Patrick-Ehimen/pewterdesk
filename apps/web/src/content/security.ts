// The Security page's copy. This page makes promises: each one has to match
// the code and CLAUDE.md's "Security-sensitive code" section, and changing
// that code may mean changing this page.
export const head = {
  label: "Security",
  title: "Your keys stay on your machine.",
  lede: "Pewterdesk has no server and holds no funds. This page is what it does with a key, what that key can do, and where the protection stops.",
};

export const backend = {
  label: "§ 01 — No backend",
  title: "There is nothing in between.",
  body: [
    "Requests go from your machine straight to the venue. There is no pewterdesk server to trust, to breach, or to go down.",
    "The venue code is Rust, running natively in the app. The interface never talks to a venue itself; it asks the Rust side, which makes every venue request.",
  ],
  route: ["Your machine", "The venue"],
  routeNote: "No account with us. No relay. No telemetry server.",
};

export const keys = {
  label: "§ 02 — Where keys live",
  title: "In your system's keychain, and nowhere else.",
  rows: [
    { label: "Stored in", value: "The OS keychain" },
    { label: "Never written to", value: "Disk · environment variables · logs" },
    { label: "Read by", value: "The Rust core, for the signing call only" },
    { label: "Sent back to the interface", value: "Never - public addresses and IDs only" },
  ],
};

export const delegated = {
  label: "§ 03 — What a key can do",
  title: "Trade-only keys, checked before they're kept.",
  body: "The app never asks for your main wallet's key. It stores a delegated key that can trade but can't move funds - and asks the venue to confirm that before saving it.",
  venues: [
    {
      name: "Bybit",
      key: "API key",
      check:
        "The app asks Bybit what the key may do and keeps it only if every permission is on a short allowlist: contract trading, nothing that moves funds.",
    },
    {
      name: "Hyperliquid",
      key: "Agent wallet",
      check:
        "Kept only if Hyperliquid lists it as an approved agent of your account. Your main wallet's own key is refused.",
    },
    {
      name: "Aster",
      key: "API wallet",
      check:
        "Generated on your machine and approved by your wallet for perpetuals only. Kept only once Aster confirms it can't withdraw.",
    },
  ],
} as const;

export const surface = {
  label: "§ 04 — What the app can sign",
  title: "A short list, fixed in the code.",
  body: "The signing code can do the first list. The second isn't hidden behind a setting; it doesn't exist.",
  can: {
    title: "Can",
    items: [
      "Place, cancel and amend orders",
      "Set take-profit, stop-loss and trailing stop",
      "Set leverage",
      "Set margin mode",
    ],
  },
  cannot: {
    title: "Can't",
    items: ["Withdraw", "Transfer", "Approve another key", "Sign data a page hands it"],
  },
  note: "Orders are placed on Bybit only for now. Hyperliquid and Aster are read-only.",
};

export const live = {
  label: "§ 05 — Live trading",
  title: "Off until you turn it on.",
  body: [
    "A Bybit demo account can trade as soon as it's connected. A live account can't: live trading is a switch per account, off by default.",
    "Turning it on asks Bybit again what the stored key may do, and refuses anything but that account's own trade-only key. If the answer can't be read, it stays off.",
  ],
};

export const limits = {
  label: "§ 06 — Limits",
  title: "What this doesn't protect you from.",
  items: [
    "This is pre-release software. Start on a demo account.",
    "A trade-only key can still lose money by trading. Size accordingly.",
    "Trading rules guard you against yourself inside the app. An order placed on the venue's own site isn't stopped by them.",
    "Alerts are checked while the app runs. Nothing fires once it's quit.",
    "Your keychain is as safe as your machine. Malware with your login is outside what any app can fix.",
  ],
  source: "Read the design record",
  code: "Read the source",
};
