// i18next initialization. Imported for its side effect in main.tsx so the
// instance is ready before <App/> renders. Resources are bundled (no HTTP
// fetch), so initialization is synchronous and there is no flash-of-English.
//
// `fallbackLng: "en"` guarantees a missing key in the active locale renders
// its English value instead of the raw key - the UI never breaks.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en/common.json";
import zhCN from "@/locales/zh-CN/common.json";
import es from "@/locales/es/common.json";
import fr from "@/locales/fr/common.json";
import ja from "@/locales/ja/common.json";
import { resolveLocale, DEFAULT_LOCALE } from "./config";

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    "zh-CN": { common: zhCN },
    es: { common: es },
    fr: { common: fr },
    ja: { common: ja },
  },
  lng: resolveLocale(),
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "common",
  ns: ["common"],
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Keep <html lang> (a11y + font rendering) and dir in sync with the locale.
// dir is pinned to "ltr"; an RTL locale can be added by flipping this.
function applyHtmlAttrs(l: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = l;
  document.documentElement.dir = "ltr";
}
applyHtmlAttrs(i18n.language);
i18n.on("languageChanged", applyHtmlAttrs);

export default i18n;
