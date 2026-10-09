// The combined selection sheet: models (with effort kept implicit) and
// personas/agents in one modal. Selection sends set_model / set_agent and
// relies on the streaming guard — the store's pendingConfig state disables
// further picks until the server confirms (spec: selection respects the
// streaming guard).

import { Modal, Text, View, Pressable, SectionList, StyleSheet } from "react-native";
import { useChatStore, type ModelInfo, type AgentInfo } from "@platform/core";
import { useTranslation } from "react-i18next";
import { palette } from "./palette";

export function SelectionPanel({
  visible,
  onClose,
  onSetModel,
  onSetAgent,
}: {
  visible: boolean;
  onClose(): void;
  onSetModel(id: string): void;
  onSetAgent(id: string): void;
}) {
  const { t } = useTranslation();
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const locked = Boolean(pendingConfig) || isStreaming;

  const sections: { title: string; data: (ModelInfo | AgentInfo)[] }[] = [
    { title: t("panel.models"), data: models },
    { title: t("panel.agents"), data: agents },
  ];

  const pick = (row: ModelInfo | AgentInfo, sectionTitle: string) => {
    if (locked) return;
    if (sectionTitle === t("panel.models") && "provider" in row) onSetModel(row.id);
    if (sectionTitle === t("panel.agents")) onSetAgent(row.id);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grab} />
          {locked && (
            <Text style={styles.locked}>{t("panel.locked")}</Text>
          )}
          <SectionList
            sections={sections}
            keyExtractor={(item, i) => `${item.id}-${i}`}
            renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
            renderItem={({ item, section }) => {
              const on =
                (section.title === t("panel.models") && (item as ModelInfo).id === currentModel) ||
                (section.title === t("panel.agents") && (item as AgentInfo).id === currentAgent);
              const name = (item as { name?: string }).name ?? (item as ModelInfo).id;
              const desc = (item as { description?: string }).description;
              return (
                <Pressable style={[styles.row, on && styles.rowOn]} onPress={() => pick(item, section.title)} disabled={locked}>
                  <Text style={[styles.rowTitle, on && { color: palette.primary }]} numberOfLines={1}>
                    {on ? "● " : "○ "}
                    {name}
                  </Text>
                  {desc && (
                    <Text style={styles.rowDesc} numberOfLines={2}>
                      {desc}
                    </Text>
                  )}
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>{t("panel.empty")}</Text>}
            style={{ flex: 1 }}
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
  locked: { color: palette.muted, fontSize: 12, paddingVertical: 8, textAlign: "center" },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: palette.muted, paddingVertical: 8, letterSpacing: 1 },
  row: { paddingHorizontal: 12, paddingVertical: 11, borderRadius: 10, gap: 2 },
  rowOn: { backgroundColor: palette.primary + "12" },
  rowTitle: { fontSize: 15, color: palette.ink },
  rowDesc: { fontSize: 12, color: palette.muted, lineHeight: 16 },
  empty: { textAlign: "center", color: palette.muted, paddingVertical: 24 },
});
