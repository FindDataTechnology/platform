// Share screen (task 5.1): the public read-only shared-session view — the
// ONE surface that fetches without any auth header (the route is public by
// design). Token entry via the field; unavailable/revoked shares get an
// explicit state, mirrored text turns render through Markdown.

import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { getSharedSession } from "@platform/core";
import { wireCore } from "@/lib/platform";
import { Markdown } from "@/components/Markdown";
import { palette } from "@/components/palette";
import { useAppStore } from "@/store/app-store";

type ViewState =
  | { kind: "entry" }
  | { kind: "loading" }
  | { kind: "ready"; title: string; messages: { role: string; content: string }[] }
  | { kind: "unavailable" };

export default function ShareScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [token, setToken] = useState("");
  const [state, setState] = useState<ViewState>({ kind: "entry" });
  const baseUrl = useAppStore((s) => s.baseUrl);

  // A token can arrive pre-filled from a share URL query in the future; v1
  // is manual entry against the connected instance (or the bare origin).
  const open = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setState({ kind: "loading" });
    try {
      // getSharedSession rides the configured public transport (no auth
      // header by design) — point it at the connected instance first.
      if (baseUrl) {
        wireCore({ baseUrl, authProvider: () => null });
      }
      const session = await getSharedSession(trimmed);
      setState({ kind: "ready", title: session.title, messages: session.messages });
    } catch {
      setState({ kind: "unavailable" });
    }
  }, [baseUrl]);

  useEffect(() => {
    if (state.kind === "unavailable" && !token) setState({ kind: "entry" });
  }, [token, state]);

  return (
    <KeyboardAvoidingView style={[styles.page, { paddingTop: insets.top + 12 }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Text style={styles.title}>{t("share.title")}</Text>

      {state.kind === "entry" || state.kind === "unavailable" ? (
        <View style={styles.entry}>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder={t("share.tokenLabel")}
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {state.kind === "unavailable" && <Text style={styles.unavailable}>{t("share.unavailable")}</Text>}
          <Pressable style={styles.button} onPress={() => void open(token)}>
            <Text style={styles.buttonText}>{t("share.open")}</Text>
          </Pressable>
        </View>
      ) : state.kind === "loading" ? (
        <Text style={styles.hint}>{t("common.loading")}</Text>
      ) : (
        <>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {state.title || t("share.title")}
          </Text>
          <FlatList
            data={state.messages}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={styles.list}
            renderItem={({ item }) =>
              item.role === "user" ? (
                <View style={styles.userRow}>
                  <View style={styles.userBubble}>
                    <Text style={styles.userText} selectable>
                      {item.content}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={styles.assistantRow}>
                  <Markdown text={item.content} />
                </View>
              )
            }
          />
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper, padding: 20 },
  title: { fontSize: 22, fontWeight: "700", color: palette.ink, marginBottom: 12 },
  entry: { gap: 10 },
  input: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: palette.ink,
  },
  unavailable: { color: palette.danger, fontSize: 13 },
  button: { backgroundColor: palette.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  hint: { color: palette.muted, paddingVertical: 20, textAlign: "center" },
  sessionTitle: { fontSize: 17, fontWeight: "600", color: palette.ink, marginBottom: 8 },
  list: { paddingBottom: 20, gap: 4 },
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 6 },
  userBubble: { backgroundColor: palette.primary, borderRadius: 14, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "85%" },
  userText: { color: "#fff", fontSize: 15, lineHeight: 22 },
  assistantRow: { paddingVertical: 6 },
});
