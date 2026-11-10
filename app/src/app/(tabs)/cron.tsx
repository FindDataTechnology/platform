// Cron tab (task 4.3): the scheduled-task list from the shared cron store,
// with schedule, state, and pause/resume — matching mini-program behavior.
// The store fills from the WS protocol; switching to this tab replays nothing
// (the runtime's onOpen queries already keep it live).

import { useCallback } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useCronStore, type CronJob } from "@platform/core";
import { palette } from "@/components/palette";
import { runtime } from "@/lib/session";

const STATE_LABEL: Record<string, string> = {
  scheduled: "cron.state.scheduled",
  running: "cron.state.running",
  paused: "cron.state.paused",
  completed: "cron.state.completed",
  expired: "cron.state.expired",
  error: "cron.state.error",
  manual: "cron.state.manual",
};

export default function CronScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const jobs = useCronStore((s) => s.jobs);
  const [refreshing] = [false];

  const toggle = useCallback((job: CronJob) => {
    if (job.status === "paused") runtime.send({ type: "cron_resume", jobId: job.id });
    else if (job.status === "scheduled") runtime.send({ type: "cron_pause", jobId: job.id });
  }, []);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <Text style={styles.title}>{t("tabs.cron")}</Text>
      <FlatList
        data={jobs}
        keyExtractor={(j) => j.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => runtime.send({ type: "cron_list" })} />}
        renderItem={({ item }) => {
          const label = t(STATE_LABEL[item.status] ?? "cron.state.scheduled");
          const togglable = item.status === "paused" || item.status === "scheduled";
          return (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={[styles.state, item.status === "error" && { color: palette.danger }, item.status === "running" && { color: palette.good }]}>
                  {label}
                </Text>
                {togglable && (
                  <Pressable style={styles.toggle} onPress={() => toggle(item)}>
                    <Text style={styles.toggleText}>
                      {item.status === "paused" ? t("cron.resume") : t("cron.pause")}
                    </Text>
                  </Pressable>
                )}
              </View>
              <Text style={styles.prompt} numberOfLines={3}>
                {item.prompt}
              </Text>
              <Text style={styles.meta}>
                {item.type === "recurring" ? (item.cron ?? "") : (item.when ?? "")}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>{t("cron.empty")}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  title: { fontSize: 22, fontWeight: "700", color: palette.ink, padding: 20, paddingBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  card: { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 14, gap: 6 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  state: { fontSize: 12, fontWeight: "700", color: palette.muted, letterSpacing: 0.5 },
  toggle: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: palette.line },
  toggleText: { fontSize: 12, color: palette.primary, fontWeight: "600" },
  prompt: { fontSize: 14, color: palette.ink, lineHeight: 20 },
  meta: { fontSize: 12, color: palette.muted, fontFamily: "Menlo" },
  empty: { textAlign: "center", color: palette.muted, paddingTop: 48, fontSize: 14 },
});
