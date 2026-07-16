import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";
import { pl, type MessageKey, type Messages } from "./messages/pl";
import { en } from "./messages/en";
import { de } from "./messages/de";
import { fr } from "./messages/fr";
import { es } from "./messages/es";
import { it } from "./messages/it";
import { tr } from "./messages/tr";

/** All dictionaries are typed against the Polish keys, so a missing translation
 *  fails the build instead of rendering an empty label. */
export const DICTIONARIES: Record<Locale, Messages> = { pl, en, de, fr, es, it, tr };

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * Falls back to the key itself, never to an empty string: a visible `nav.foo`
 * on screen is a bug report, whereas a blank space hides for months.
 */
export function createTranslator(locale: Locale): Translate {
  const dictionary = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];

  return (key, values) => {
    let text: string = dictionary[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

/** Picks the best supported locale from an Accept-Language header. */
export function localeFromHeader(header: string | null): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (isLocale(tag)) return tag;
  }
  return null;
}

export { DEFAULT_LOCALE, isLocale };
export type { Locale, MessageKey, Messages };
