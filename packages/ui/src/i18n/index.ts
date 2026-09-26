// Interface strings. English is the source of truth (locales/en.ts); every
// other locale is typed against it, so a missing or extra key fails the
// typecheck. The language is fixed for a session — switching reloads the
// app — so this is a module-level catalogue, not React context: components,
// hooks and plain functions can all call `t`.

import { en, type MessageKey, type Messages } from "./locales/en";

export type { MessageKey, Messages };

/** Supported interface languages, as BCP 47 codes. */
export const LOCALES = ["en", "zh", "ko", "ja", "es", "ru", "fr", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

const loaders: Record<Exclude<Locale, "en">, () => Promise<{ messages: Messages }>> = {
  zh: () => import("./locales/zh"),
  ko: () => import("./locales/ko"),
  ja: () => import("./locales/ja"),
  es: () => import("./locales/es"),
  ru: () => import("./locales/ru"),
  fr: () => import("./locales/fr"),
  pt: () => import("./locales/pt"),
};

let current: Locale = "en";
let messages: Messages = en;

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * Loads `locale`'s strings; call once before the first render. If a bundle
 * fails to load, the app stays in English rather than not starting.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === "en") {
    current = "en";
    messages = en;
    return;
  }
  try {
    messages = (await loaders[locale]()).messages;
    current = locale;
  } catch {
    current = "en";
    messages = en;
  }
}

export function currentLocale(): Locale {
  return current;
}

/** The string for `key`, with `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = messages[key] ?? en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** BCP 47 tags for Intl, where the bare language code is ambiguous. */
const INTL_TAG: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  ko: "ko-KR",
  ja: "ja-JP",
  es: "es-ES",
  ru: "ru-RU",
  fr: "fr-FR",
  pt: "pt-BR",
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Dates and times in the interface language (month names, ordering). Numbers
 * deliberately stay en-US everywhere: prices and sizes read the same in every
 * language, and a decimal comma can't be mistaken for a thousands separator
 * once orders are typed in.
 */
export function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${current}:${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(INTL_TAG[current], options);
    dateFormats.set(key, format);
  }
  return format;
}

/** A language's name in the interface language, e.g. "Japanese" or "日语". */
export function languageName(locale: Locale): string {
  try {
    return (
      new Intl.DisplayNames([INTL_TAG[current]], { type: "language" }).of(INTL_TAG[locale]) ??
      locale
    );
  } catch {
    return locale;
  }
}
