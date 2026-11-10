// Resources tab (task 4.3): the library list with type filter and search,
// chart preview through the embedded renderer, file rows with size metadata.
// Reflects server state on refresh (pull-to-refresh re-lists).

import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, TextInput, Modal, StyleSheet, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { listResources, type Resource } from "@platform/core";
import { palette } from "@/components/palette";
import { ChartView } from "@/components/ChartView";
import { wireCore } from "@/lib/platform";
import { useAppStore } from "@/store/app-store";

export default function ResourcesScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | "chart" | "file">("all");
  const [preview, setPreview] = useState<Resource | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const baseUrl = useAppStore.getState().baseUrl;
      const token = useAppStore.getState().token;
      if (baseUrl && token) {
        wireCore({ baseUrl, authProvider: () => (token ? `Bearer ${token}` : null) });
      }
      const list = await listResources({ limit: 200 });
      setResources(list.items);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (resources ?? []).filter(
    (r) => (type === "all" || r.type === type) && (!query || r.title.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <Text style={styles.title}>{t("tabs.resources")}</Text>
      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t("resources.search")}
          placeholderTextColor={palette.muted}
        />
        <View style={styles.filters}>
          {(["all", "chart", "file"] as const).map((k) => (
            <Pressable key={k} style={[styles.filter, type === k && styles.filterOn]} onPress={() => setType(k)}>
              <Text style={[styles.filterText, type === k && { color: palette.primary, fontWeight: "600" }]}>
                {t(`resources.type.${k}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={resources === null} onRefresh={() => void load()} />}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => (item.type === "chart" ? setPreview(item) : undefined)}>
            <Text style={styles.cardGlyph}>{item.type === "chart" ? "📈" : "📄"}</Text>
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.cardMeta}>
                {item.type === "file" && item.fileSize != null
                  ? `${(item.fileSize / 1024).toFixed(1)} KB`
                  : item.sessionTitle || ""}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>{failed ? t("common.error") : t("resources.empty")}</Text>
        }
      />

      <Modal visible={preview !== null} animationType="slide" transparent onRequestClose={() => setPreview(null)}>
        <View style={styles.previewScrim}>
          <View style={styles.previewSheet}>
            <Pressable style={styles.previewClose} onPress={() => setPreview(null)}>
              <Text style={styles.previewCloseText}>✕</Text>
            </Pressable>
            <Text style={styles.previewTitle} numberOfLines={1}>
              {preview?.title}
            </Text>
            {preview?.type === "chart" && preview.payload ? (
              <ChartView option={safeParse(preview.payload)} height={280} />
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { title: json.slice(0, 200) };
  }
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  title: { fontSize: 22, fontWeight: "700", color: palette.ink, padding: 20, paddingBottom: 8 },
  controls: { paddingHorizontal: 16, gap: 8, paddingBottom: 8 },
  search: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    backgroundColor: palette.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: palette.ink,
  },
  filters: { flexDirection: "row", gap: 6 },
  filter: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.card },
  filterOn: { borderColor: palette.primary, backgroundColor: palette.primary + "10" },
  filterText: { fontSize: 12.5, color: palette.muted },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 8 },
  card: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 12 },
  cardGlyph: { fontSize: 18 },
  cardBody: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 14.5, color: palette.ink },
  cardMeta: { fontSize: 12, color: palette.muted },
  empty: { textAlign: "center", color: palette.muted, paddingTop: 48, fontSize: 14 },
  previewScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 20 },
  previewSheet: { backgroundColor: palette.paper, borderRadius: 16, padding: 16, gap: 10 },
  previewClose: { alignSelf: "flex-end", width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  previewCloseText: { fontSize: 16, color: palette.muted },
  previewTitle: { fontSize: 16, fontWeight: "600", color: palette.ink },
});
