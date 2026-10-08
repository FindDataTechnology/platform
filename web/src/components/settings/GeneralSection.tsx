// Settings → General: appearance and language.
//
// Both controls previously had no good home — theme did not exist, and the
// locale <select> occupied permanent space in the sidebar footer.

import { useTranslation } from "react-i18next";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { useLanguage } from "@/i18n/useLanguage";
import type { Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

export function GeneralSection() {
  const { t } = useTranslation();
  const { theme, themes, setTheme } = useTheme();
  const { locale, locales, changeLocale } = useLanguage();

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="settings-general">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("settings.general.theme")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.general.themeHint")}</p>
        <div
          role="radiogroup"
          aria-label={t("settings.general.theme")}
          data-testid="theme-control"
          className="mt-1 inline-flex w-fit rounded-md border border-input p-0.5"
        >
          {themes.map((opt: Theme) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={theme === opt}
              data-testid={`theme-option-${opt}`}
              data-active={theme === opt ? "true" : "false"}
              onClick={() => setTheme(opt)}
              className={cn(
                "rounded px-3 py-1.5 text-xs transition-colors",
                theme === opt
                  ? "bg-primary-deep text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(`settings.general.themeOption.${opt}`)}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("sidebar.language")}</h2>
        <select
          value={locale}
          onChange={(e) => changeLocale(e.target.value as Locale)}
          data-testid="locale-select"
          aria-label={t("sidebar.language")}
          className={cn(
            "w-fit min-w-48 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground",
            "focus:border-primary focus:outline-none",
          )}
        >
          {locales.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}
