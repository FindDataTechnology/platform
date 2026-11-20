// useLanguage: reactive access to the active locale + a setter that persists
// the choice and triggers a tree-wide re-render via react-i18next's context.
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SUPPORTED_LOCALES,
  LOCALE_DISPLAY_NAMES,
  DEFAULT_LOCALE,
  STORAGE_KEY,
  type Locale,
} from "./config";

export interface LocaleOption {
  code: Locale;
  label: string;
}

export function useLanguage() {
  const { i18n } = useTranslation();
  const locale: Locale = (SUPPORTED_LOCALES as readonly string[]).includes(i18n.language)
    ? (i18n.language as Locale)
    : DEFAULT_LOCALE;
  const locales = useMemo<LocaleOption[]>(
    () => SUPPORTED_LOCALES.map((code) => ({ code, label: LOCALE_DISPLAY_NAMES[code] })),
    [],
  );
  const changeLocale = useCallback(
    (code: Locale) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, code);
      } catch {
        /* localStorage unavailable - session-only switch */
      }
      void i18n.changeLanguage(code); // fires languageChanged -> <html lang> + re-render
    },
    [i18n],
  );
  return { locale, locales, changeLocale };
}
