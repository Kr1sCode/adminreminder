/**
 * Locale is kept in a cookie rather than in the URL. A self-hosted admin tool
 * has no SEO to serve and no anonymous traffic to segment by language, so
 * /en/dashboard would buy nothing and cost every link in the app.
 */

export const LOCALES = ["pl", "en", "de", "fr", "es", "it", "tr"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "pl";

/** Names in the language itself: a Turkish speaker looks for "Türkçe". */
export const LOCALE_NAMES: Record<Locale, string> = {
  pl: "Polski",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  tr: "Türkçe",
};

export const LOCALE_FLAGS: Record<Locale, string> = {
  pl: "🇵🇱",
  en: "🇬🇧",
  de: "🇩🇪",
  fr: "🇫🇷",
  es: "🇪🇸",
  it: "🇮🇹",
  tr: "🇹🇷",
};

export const LOCALE_COOKIE = "ar_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
