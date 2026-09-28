import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@pewterdesk/ui/src/styles/styles.css";
import "./styles/app.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/settings.css";
import "./styles/tray.css";
import { loadLocale } from "@pewterdesk/ui";
import { App } from "./App";
import { SPLASH_FADE_MS, Splash, SWITCH_SPLASH_MS } from "./components/Splash";
import { applyStoredAppearance } from "./hooks/useAppearance";
import { forgetWatchedAddress } from "./lib/account";
import { storedLanguage, takeLanguageSwitch } from "./lib/language";
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
  // Theme first, so the splash itself is drawn in the right one.
  applyStoredAppearance();
  forgetWatchedAddress();
  const locale = storedLanguage();
  const switching = takeLanguageSwitch();

  root.render(<Splash />);
  await Promise.all([
    loadLocale(locale),
    switching ? new Promise((resolve) => setTimeout(resolve, SWITCH_SPLASH_MS)) : null,
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

void (location.hash === "#tray" ? startTrayPanel() : start());
