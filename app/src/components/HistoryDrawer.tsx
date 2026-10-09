// Session history as a bottom sheet: the sessions list from the store, tap
// to switch (switch_session), ＋ for a new session. Titles/updated times
// come from SessionMeta.

import { Modal, Text, View, Pressable, FlatList, StyleSheet } from "react-native";
import { useChatStore, type SessionMeta } from "@platform/core";
import { useTranslation } from "react-i18next";
import { palette } from "./palette";

export function HistoryDrawer({
  visible,
  onClose,
  onSwitch,
  onNewSession,
}: {
  visible: boolean;
  onClose(): void;
  onSwitch(id: string): void;
  onNewSession(): void;
}) {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grab} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>{t("history.title")}</Text>
            <Pressable style={styles.newButton} onPress={onNewSession}>
              <Text style={styles.newButtonText}>{t("history.newSession")}</Text>
            </Pressable>
          </View>
          <FlatList
            data={sessions}
            keyExtractor={(s) => s.id}
            style={{ flex: 1 }}
            renderItem={({ item }: { item: SessionMeta }) => {
              const on = item.id === currentSessionId;
              return (
                <Pressable style={[styles.row, on && styles.rowOn]} onPress={() => onSwitch(item.id)}>
                  <Text style={[styles.rowTitle, on && { color: palette.primary }]} numberOfLines={1}>
                    {item.title || t("history.untitled")}
                  </Text>
                  <Text style={styles.rowTime}>{item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ""}</Text>
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>{t("history.empty")}</Text>}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: palette.paper,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    height: "70%",
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  grab: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: palette.line, marginTop: 8 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 },
  title: { fontSize: 17, fontWeight: "700", color: palette.ink },
  newButton: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: palette.primary },
  newButtonText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  row: { paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, gap: 2 },
  rowOn: { backgroundColor: palette.primary + "12" },
  rowTitle: { fontSize: 15, color: palette.ink },
  rowTime: { fontSize: 12, color: palette.muted },
  empty: { textAlign: "center", color: palette.muted, paddingVertical: 24, fontSize: 14 },
});
