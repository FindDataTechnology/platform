// i18next initialization. `initI18n()` is awaited by main.tsx BEFORE the
// React tree renders, so the active locale's bundle is present at first paint
// and there is no flash-of-English.
//
// Only two bundles ride the first paint: `en` (static — the fallback must never
// wait for a network round trip) and the ACTIVE locale. The other three are
// dynamic thunks with static specifiers, so Vite emits one chunk per locale
// (openspec: slim-i18n-payload; gate: scripts/check-i18n-split.mjs).
//
// `fallbackLng: "en"` guarantees a missing key in the active locale renders
// its English value instead of the raw key - the UI never breaks.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en/common.json";
import { resolveLocale, DEFAULT_LOCALE, type Locale } from "./config";

// Static specifiers, one per locale: a template literal here would make Vite
// either inline every bundle or emit unusable dynamic paths.
const LOCALE_LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: unknown }>> = {
  "zh-CN": () => import("@/locales/zh-CN/common.json"),
  es: () => import("@/locales/es/common.json"),
  fr: () => import("@/locales/fr/common.json"),
  ja: () => import("@/locales/ja/common.json"),
};

/**
 * Load one locale's bundle and register it. Resolves when the bundle is in
 * place; rejects (without touching what is already loaded) when the chunk
 * cannot be fetched.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (i18n.hasResourceBundle(locale, "common")) return;
  if (locale === "en") return; // static, always present
  const mod = await LOCALE_LOADERS[locale]();
  i18n.addResourceBundle(locale, "common", mod.default, true, true);
}

let initialized = false;

/**
 * Initialize i18next with `en` + the active locale, registering the react
 * binding. Idempotent: a second call resolves immediately.
 */
export async function initI18n(): Promise<void> {
  if (initialized) return;
  const active = resolveLocale();
  // The active bundle goes in WITH `resources`: i18n.init REPLACES the resource
  // store, so an addResourceBundle() called before it is silently discarded —
  // which would render English to a zh-CN user.
  // Typed as the shape i18next itself expects (`Resource`): `unknown` does not
  // satisfy `ResourceKey`, and CI's typecheck caught exactly that.
  const resources: Record<string, { common: Record<string, unknown> }> = { en: { common: en as Record<string, unknown> } };
  let lng: Locale = active;
  if (active !== "en") {
    try {
      const mod = await LOCALE_LOADERS[active]();
      resources[active] = { common: mod.default as Record<string, unknown> };
    } catch (e) {
      // The app must start regardless (product principle 1). Falling back to
      // `en` keeps every string resolvable; rendering with NO resource store
      // would paint raw keys. The caller reports the failure.
      console.warn(`[i18n] "${active}" bundle failed to load; starting in English`, e);
      lng = DEFAULT_LOCALE;
    }
  }

  i18n.use(initReactI18next);
  await i18n.init({
    resources,
    lng,
    fallbackLng: DEFAULT_LOCALE,
    defaultNS: "common",
    ns: ["common"],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  initialized = true;
}

// Keep <html lang> (a11y + font rendering) and dir in sync with the locale.
// dir is pinned to "ltr"; an RTL locale can be added by flipping this.
function applyHtmlAttrs(l: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = l;
  document.documentElement.dir = "ltr";
}
applyHtmlAttrs(i18n.language ?? resolveLocale());
i18n.on("languageChanged", applyHtmlAttrs);

export default i18n;
