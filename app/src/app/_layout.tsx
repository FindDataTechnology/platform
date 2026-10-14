// Root layout: init i18n once, then route. The tab shell requires a connected
// instance — unpaired launches land on /pair via (tabs)/_layout's gate; share
// and pair themselves stay reachable pre-pairing.

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { initI18n } from "@/i18n";
import { useAppStore } from "@/store/app-store";

export { ErrorBoundary } from "expo-router";

export default function RootLayout() {
  initI18n();
  const { i18n } = useTranslation();
  useEffect(() => {
    const unsub = useAppStore.subscribe((s) => {
      if (s.locale && s.locale !== i18n.language) void i18n.changeLanguage(s.locale);
    });
    return unsub;
  }, [i18n]);

  return (
    <>
      {/* v1 is light-only (grill decision): the bar stays dark-on-light. */}
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
