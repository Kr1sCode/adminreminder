"use client";

import { createContext, useContext, useMemo } from "react";
import { createTranslator, type Locale, type Translate } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/lib/i18n/locales";

interface I18nValue {
  locale: Locale;
  t: Translate;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * The locale arrives from the server, which read it from a cookie, so the first
 * paint is already in the right language — no flash of Polish before hydration.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: createTranslator(locale),
      setLocale: (next: Locale) => {
        // A year, path-wide, lax: the choice is a preference, not a credential.
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        // Full reload rather than router.refresh(): server components hold
        // translated strings too, and this guarantees every one of them re-renders.
        window.location.reload();
      },
    }),
    [locale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (context) return context;

  // Rendered outside the provider (a stray dialog, a test): still translate,
  // rather than crash, using the default locale.
  return {
    locale: DEFAULT_LOCALE,
    t: createTranslator(DEFAULT_LOCALE),
    setLocale: () => {},
  };
}

/** Shorthand for the common case. */
export function useT(): Translate {
  return useI18n().t;
}
