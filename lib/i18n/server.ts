import { cookies } from "next/headers";
import { createTranslator, DEFAULT_LOCALE, isLocale, type Locale, type Translate } from "./index";
import { LOCALE_COOKIE } from "./locales";

/** Locale for server components and route handlers: same cookie the client sets. */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function getT(): Promise<Translate> {
  return createTranslator(await getLocale());
}
