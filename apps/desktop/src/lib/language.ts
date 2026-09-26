import { flags } from "@pewterdesk/assets";
import { isLocale, type Locale } from "@pewterdesk/ui";

const STORAGE_KEY = "pd.language";
/** Set across the reload a language switch triggers, so startup knows to linger on the splash. */
const SWITCHING_KEY = "pd.languageSwitch";

/** The picker's languages: each one's own name and a flag for it. */
export const LANGUAGES: readonly { code: Locale; name: string; flag: string }[] = [
  { code: "en", name: "English", flag: flags.us },
  { code: "zh", name: "简体中文", flag: flags.cn },
  { code: "ko", name: "한국어", flag: flags.kr },
  { code: "ja", name: "日本語", flag: flags.jp },
  { code: "es", name: "Español", flag: flags.es },
  { code: "ru", name: "Русский", flag: flags.ru },
  { code: "fr", name: "Français", flag: flags.fr },
  { code: "pt", name: "Português", flag: flags.br },
];

/** The saved interface language, or English. */
export function storedLanguage(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLocale(saved) ? saved : "en";
  } catch {
    return "en";
  }
}

/**
 * Saves `locale` and reloads, so the app starts over in it (behind the
 * splash) rather than re-rendering every string in place.
 */
export function switchLanguage(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    return; // Can't persist it, so a reload would come back in the old language.
  }
  try {
    sessionStorage.setItem(SWITCHING_KEY, "1");
  } catch {
    // Only the splash's minimum time is lost.
  }
  window.location.reload();
}

/** Whether this start follows a language switch; clears the flag. */
export function takeLanguageSwitch(): boolean {
  try {
    const switching = sessionStorage.getItem(SWITCHING_KEY) === "1";
    sessionStorage.removeItem(SWITCHING_KEY);
    return switching;
  } catch {
    return false;
  }
}
