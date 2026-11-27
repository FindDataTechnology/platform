// i18n bootstrap: two locales (zh-CN / en), system language as the first-run
// default, the persisted choice always winning afterwards. Assets are local —
// the instance has no localization contract (design D6).

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { I18nManager } from "react-native";
import zhCN from "./zh-CN.json";
import en from "./en.json";
import { useAppStore } from "@/store/app-store";

export const APP_LOCALES = ["zh-CN", "en"] as const;

export function systemLocale(): "zh-CN" | "en" {
  const tag = I18nManager.getConstants().localeIdentifier ?? "";
  return tag.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

let initialized = false;
export function initI18n(): void {
  if (initialized) return;
  const stored = useAppStore.getState().locale;
  void i18next.use(initReactI18next).init({
    lng: stored ?? systemLocale(),
    fallbackLng: "en",
    resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });
  initialized = true;
}

export async function changeLocale(locale: "zh-CN" | "en"): Promise<void> {
  useAppStore.getState().setLocale(locale);
  await i18next.changeLanguage(locale);
}
