// i18n locale configuration + resolution.
//
// Supported locales and their endonyms (each locale is labeled in its own
// language in the switcher). `en` is the source-of-truth and default; the
// others are parallel translation files. The active locale is resolved at
// boot: explicit stored choice -> browser language best match -> `en`.

export const SUPPORTED_LOCALES = ["en", "zh-CN", "es", "fr", "ja"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE = "en" satisfies Locale;
export const STORAGE_KEY = "platform.locale";

// Each locale's endonym (displayed in its own language in the switcher).
export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  es: "Español",
  fr: "Français",
  ja: "日本語",
};

function isSupported(l: string): l is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(l);
}

// Resolve the active locale: explicit stored choice -> browser language best
// match (exact, then primary-subtag) -> default. Safe under SSR/no-window.
export function resolveLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isSupported(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  const langs =
    typeof navigator !== "undefined"
      ? Array.from(navigator.languages?.length ? navigator.languages : [navigator.language ?? ""])
      : [];
  // Exact match first (case-insensitive), e.g. "zh-CN" -> "zh-CN".
  for (const lang of langs) {
    if (!lang) continue;
    const lower = lang.toLowerCase();
    const exact = (SUPPORTED_LOCALES as readonly string[]).find((s) => s.toLowerCase() === lower);
    if (exact) return exact as Locale;
  }
  // Then primary-subtag match, e.g. "zh-TW" -> "zh-CN", "es-MX" -> "es".
  for (const lang of langs) {
    if (!lang) continue;
    const primary = lang.toLowerCase().split(/[-_]/)[0];
    if (!primary) continue;
    const match = (SUPPORTED_LOCALES as readonly string[]).find(
      (s) => s.toLowerCase().split("-")[0] === primary,
    );
    if (match) return match as Locale;
  }
  return DEFAULT_LOCALE;
}
