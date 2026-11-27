// useLanguage: reactive access to the active locale + a setter that loads the
// target bundle on demand, persists the choice, and re-renders the tree.
//
// The switch is ASYNC because only the active locale rides the first paint
// (openspec: slim-i18n-payload): a locale the user has never used is a chunk
// that still has to be fetched. The order matters — load, then change, then
// persist — because persisting first would pin the next boot to a locale whose
// bundle may never have arrived.
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SUPPORTED_LOCALES,
  LOCALE_DISPLAY_NAMES,
  DEFAULT_LOCALE,
  STORAGE_KEY,
  type Locale,
} from "./config";
import { loadLocale } from "./index";

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
  /**
   * Switch locale. Resolves once the UI renders in `code`; rejects when the
   * bundle could not be loaded, in which case the active locale, the stored
   * choice, and the rendered strings are all unchanged.
   */
  const changeLocale = useCallback(
    async (code: Locale): Promise<void> => {
      if (code === i18n.language) return;
      await loadLocale(code); // throws before any state moves
      await i18n.changeLanguage(code); // fires languageChanged -> <html lang> + re-render
      try {
        window.localStorage.setItem(STORAGE_KEY, code);
      } catch {
        /* localStorage unavailable - session-only switch */
      }
    },
    [i18n],
  );
  return { locale, locales, changeLocale };
}
