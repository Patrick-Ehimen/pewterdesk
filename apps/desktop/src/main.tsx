import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@pewterdesk/ui/src/styles/styles.css";
import "./styles/app.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/settings.css";
import "./styles/tray.css";
import "./styles/float.css";
import "./styles/wallet.css";
import "./styles/onboarding.css";
import { loadLocale } from "@pewterdesk/ui";
import { App } from "./App";
import { ChartWindow } from "./chart/ChartWindow";
import { SPLASH_FADE_MS, Splash, SWITCH_SPLASH_MS } from "./components/Splash";
import { FloatWindow } from "./float/FloatWindow";
import { applyStoredAppearance } from "./hooks/useAppearance";
import { forgetWatchedAddress } from "./lib/account";
import { storedLanguage, takeLanguageSwitch } from "./lib/language";
import { installReloadShortcut, wasReloaded } from "./lib/reload";
import { TrayPanel } from "./tray/TrayPanel";

const el = document.getElementById("root");
if (!el) throw new Error("#root element missing from index.html");
const root = createRoot(el);

/** The menu-bar panel: the same frontend, loaded in its own window at #tray. */
async function startTrayPanel() {
  applyStoredAppearance();
  const locale = storedLanguage();
  await loadLocale(locale);
  document.documentElement.lang = locale;
  root.render(
    <StrictMode>
      <TrayPanel />
    </StrictMode>,
  );
}

async function start() {
  installReloadShortcut();
  // Theme first, so the splash itself is drawn in the right one.
  applyStoredAppearance();
  forgetWatchedAddress();
  const locale = storedLanguage();
  // A reload holds the splash like a language switch, so it doesn't just flash.
  const holdSplash = takeLanguageSwitch() || wasReloaded();

  root.render(<Splash />);
  await Promise.all([
    loadLocale(locale),
    holdSplash ? new Promise((resolve) => setTimeout(resolve, SWITCH_SPLASH_MS)) : null,
  ]);
  document.documentElement.lang = locale;

  // The app mounts underneath while the splash fades out on top of it, then
  // the splash goes. App keeps its position in the tree, so it isn't remounted.
  root.render(
    <StrictMode>
      <App />
      <Splash leaving />
    </StrictMode>,
  );
  setTimeout(
    () =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    SPLASH_FADE_MS,
  );
}

/** The floating window: the same frontend again, in its own window at #float. */
async function startFloatWindow() {
  applyStoredAppearance();
  const locale = storedLanguage();
  await loadLocale(locale);
  document.documentElement.lang = locale;
  root.render(
    <StrictMode>
      <FloatWindow />
    </StrictMode>,
  );
}

/** A popped-out chart: the same frontend once more, at #chart?… */
async function startChartWindow() {
  applyStoredAppearance();
  const locale = storedLanguage();
  await loadLocale(locale);
  document.documentElement.lang = locale;
  root.render(
    <StrictMode>
      <ChartWindow />
    </StrictMode>,
  );
}

void (location.hash === "#tray"
  ? startTrayPanel()
  : location.hash === "#float"
    ? startFloatWindow()
    : location.hash.startsWith("#chart?")
      ? startChartWindow()
      : start());
