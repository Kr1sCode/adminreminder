"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, Languages } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { LOCALES, LOCALE_FLAGS, LOCALE_NAMES } from "@/lib/i18n/locales";

/** Sits next to the theme toggle; both are preferences, both persist in a cookie. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <Popover>
      <PopoverTrigger>
        <span
          role="button"
          aria-label={t("lang.change")}
          title={t("lang.change")}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Languages className="h-4 w-4" />
        </span>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-52 p-1">
        <div className="px-2 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          {t("lang.label")}
        </div>
        {LOCALES.map((code) => {
          const active = code === locale;
          return (
            <Button
              key={code}
              variant="ghost"
              onClick={() => !active && setLocale(code)}
              className="w-full justify-start gap-2 h-9 px-2 font-normal"
            >
              <span aria-hidden className="text-base leading-none">{LOCALE_FLAGS[code]}</span>
              <span className="flex-1 text-left">{LOCALE_NAMES[code]}</span>
              {active && <Check className="h-4 w-4 text-emerald-500" />}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
