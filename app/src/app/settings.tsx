// Settings (task 5.2): the connected instance with live reachability, unbind
// and switch (revoke server-side → clear → pairing screen), the zh/en
// language switch applying immediately, and app version info.

import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Alert } from "react-native";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";
import { changeLocale } from "@/i18n";
import { runtime } from "@/lib/session";
import { useAppStore } from "@/store/app-store";

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const baseUrl = useAppStore((s) => s.baseUrl);
  const email = useAppStore((s) => s.email);
  const [reachable, setReachable] = useState<"checking" | "up" | "down">("checking");

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch(`${baseUrl?.replace(/\/+$/, "")}/api/config`);
        if (alive) setReachable(res.status < 500 ? "up" : "down");
      } catch {
        if (alive) setReachable("down");
      }
    };
    void probe();
    const id = setInterval(probe, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [baseUrl]);

  const unbind = useCallback(() => {
    Alert.alert(t("settings.unbind"), t("settings.unbindConfirm"), [
      { text: t("settings.cancel"), style: "cancel" },
      {
        text: t("settings.confirm"),
        style: "destructive",
        onPress: () => {
          void runtime.unbind();
        },
      },
    ]);
  }, [t]);

  const version = Constants.expoConfig?.version ?? "0.1.0";
  const active = (l: string) => (i18n.language?.startsWith(l) ?? false);

  return (
    <ScrollView style={[styles.page, { paddingTop: insets.top + 12 }]} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{t("settings.title")}</Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t("settings.instance")}</Text>
        <Text style={styles.instance} selectable>
          {baseUrl}
        </Text>
        {email && <Text style={styles.email}>{email}</Text>}
        <View style={styles.reachRow}>
          {reachable === "checking" ? (
            <ActivityIndicator size="small" />
          ) : (
            <View style={[styles.dot, reachable === "up" ? styles.dotUp : styles.dotDown]} />
          )}
          <Text style={styles.reachText}>
            {reachable === "up" ? t("settings.reachability") : t("settings.unreachable")}
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t("settings.language")}</Text>
        <View style={styles.langRow}>
          {(["zh-CN", "en"] as const).map((l) => (
            <Pressable
              key={l}
              style={[styles.langButton, active(l) && styles.langButtonOn]}
              onPress={() => void changeLocale(l)}
            >
              <Text style={[styles.langText, active(l) && { color: palette.primary, fontWeight: "600" }]}>
                {t(l === "zh-CN" ? "settings.lang.zh" : "settings.lang.en")}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable style={styles.dangerCard} onPress={unbind}>
        <Text style={styles.dangerText}>{t("settings.unbind")}</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t("settings.about")}</Text>
        <Text style={styles.versionText}>
          {t("settings.version")} {version}
        </Text>
      </View>
    </ScrollView>
  );
}

// The active locale for the pill highlight (startsWith covers zh-CN*).


const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: "700", color: palette.ink, marginBottom: 4 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.line, borderRadius: 14, padding: 16, gap: 6 },
  cardLabel: { fontSize: 12, fontWeight: "700", color: palette.muted, letterSpacing: 0.5 },
  instance: { fontSize: 15, color: palette.ink },
  email: { fontSize: 13, color: palette.muted },
  reachRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotUp: { backgroundColor: palette.good },
  dotDown: { backgroundColor: palette.danger },
  reachText: { fontSize: 13, color: palette.muted },
  langRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  langButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: palette.line },
  langButtonOn: { borderColor: palette.primary, backgroundColor: palette.primary + "10" },
  langText: { fontSize: 14, color: palette.ink },
  dangerCard: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.danger + "55", borderRadius: 14, padding: 16, alignItems: "center" },
  dangerText: { color: palette.danger, fontSize: 15, fontWeight: "600" },
  versionText: { fontSize: 13, color: palette.muted },
});
