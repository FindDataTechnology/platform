// 待办 tab (openspec: owner-inbox). The native client's face of the same
// aggregation the web surface and the mini program read: one endpoint, one set
// of actions, one set of approve-consequence strings (server-derived).
//
// Rendering differences are allowed; semantics are not. RN has no good diff
// widget, so evidence falls back to readable text — the spec says a client that
// cannot style evidence must still SHOW it, and must not drop an action just
// because it could not render a preview.
//
// An instance that does not advertise the capability renders the honest absent
// state ("this instance has no inbox yet"), never an empty queue.

import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  fetchInbox,
  itemsInBucket,
  runAction,
  type InboxItem,
  type InboxPayload,
} from "@platform/core";
import { palette } from "@/components/palette";

type Segment = "waiting" | "inflight";

export default function InboxScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [absent, setAbsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [segment, setSegment] = useState<Segment>("waiting");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const body = await fetchInbox();
      setAbsent(false);
      setPayload(body);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // 404 = an instance older than this capability: honest absence, not an
      // empty queue and not an error page.
      if (/\b404\b/.test(msg)) {
        setAbsent(true);
        setPayload(null);
      } else {
        setError(msg);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (item: InboxItem, op: string) => {
    const action = item.actions.find((a) => a.op === op);
    if (!action) return;
    setBusy(`${item.itemRef}:${op}`);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {};
      if (op === "approve" || op === "amend") {
        body.choice = item.recommendation ?? item.options?.[0]?.value ?? "";
      }
      const res = await runAction(action, body, item.actions);
      if (res.ok) {
        setNotice(t("inbox.done", { title: item.title, action: action.label }));
        await load();
      } else {
        const data = res.data as { error?: string } | null;
        setNotice(t("inbox.failed", { title: item.title, error: data?.error ?? `HTTP ${res.status}` }));
      }
    } catch (e) {
      setNotice(t("inbox.failed", { title: item.title, error: String((e as Error)?.message ?? e) }));
    } finally {
      setBusy(null);
    }
  };

  const items = itemsInBucket(payload, segment);
  const failed = (payload?.lanes ?? []).filter((l) => l.status === "error");

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <Text style={styles.title}>{t("tabs.inbox")}</Text>

      <View style={styles.segments}>
        {(["waiting", "inflight"] as Segment[]).map((s) => (
          <Pressable key={s} onPress={() => setSegment(s)} style={[styles.segment, segment === s && styles.segmentOn]}>
            <Text style={[styles.segmentText, segment === s && styles.segmentTextOn]}>
              {t(`inbox.segment.${s}`)}
              {payload ? ` · ${s === "waiting" ? payload.counts.waiting : payload.counts.inflight}` : ""}
            </Text>
          </Pressable>
        ))}
      </View>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? <Text style={styles.error}>{t("inbox.loadError", { message: error })}</Text> : null}
      {absent ? <Text style={styles.empty}>{t("inbox.absent")}</Text> : null}
      {failed.length > 0 ? (
        <View style={styles.laneError}>
          {failed.map((l) => (
            <Text key={l.id} style={styles.error}>
              {t("inbox.laneError", { lane: l.label, message: l.error ?? "" })}
            </Text>
          ))}
        </View>
      ) : null}

      {payload ? (
        <FlatList
          data={items}
          keyExtractor={(i) => `${i.laneId}:${i.itemRef}`}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}
          ListEmptyComponent={
            <Text style={styles.empty}>{segment === "waiting" ? t("inbox.empty.waiting") : t("inbox.empty.inflight")}</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.chip}>{t(`inbox.type.${item.itemType}`)}</Text>
                <Text style={styles.origin}>{item.originLabel}</Text>
              </View>
              <Text style={styles.itemTitle}>{item.title}</Text>
              {/* The consequence is the point: stated before the buttons. */}
              <Text style={styles.consequence}>{item.consequence}</Text>
              {item.evaluation && item.evaluation.status !== "passed" ? (
                <Text style={styles.eval}>{t(`inbox.eval.${item.evaluation.status}`)}</Text>
              ) : null}
              {item.evidence ? (
                <ScrollView style={styles.evidence} horizontal={false}>
                  <Text style={styles.evidenceText}>{JSON.stringify(item.evidence, null, 2)}</Text>
                </ScrollView>
              ) : null}
              <View style={styles.actions}>
                {item.actions
                  .filter((a) => a.op !== "evaluate")
                  .map((a) => (
                    <Pressable
                      key={a.op}
                      disabled={busy !== null}
                      onPress={() => void act(item, a.op)}
                      style={[styles.btn, (a.op === "reject" || a.op === "reopen") && styles.btnGhost]}
                    >
                      <Text style={styles.btnText}>
                        {busy === `${item.itemRef}:${a.op}` ? t("inbox.working") : a.label}
                      </Text>
                    </Pressable>
                  ))}
              </View>
            </View>
          )}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  title: { fontSize: 18, fontWeight: "600", color: palette.ink, paddingHorizontal: 16, paddingVertical: 10 },
  segments: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  segment: { borderRadius: 8, borderWidth: 1, borderColor: palette.line, paddingHorizontal: 10, paddingVertical: 6 },
  segmentOn: { borderColor: palette.primary, backgroundColor: "#EEF1FE" },
  segmentText: { fontSize: 12, color: palette.muted },
  segmentTextOn: { color: palette.primary, fontWeight: "600" },
  notice: { paddingHorizontal: 16, paddingBottom: 6, fontSize: 12, color: palette.ink },
  error: { paddingHorizontal: 16, paddingBottom: 6, fontSize: 12, color: palette.danger },
  laneError: { paddingBottom: 4 },
  empty: { textAlign: "center", color: palette.muted, fontSize: 13, paddingVertical: 28 },
  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.card,
    padding: 12,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  chip: { fontSize: 11, color: palette.primary, backgroundColor: "#EEF1FE", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  origin: { fontSize: 12, color: palette.muted },
  itemTitle: { marginTop: 6, fontSize: 14, fontWeight: "600", color: palette.ink },
  consequence: { marginTop: 4, fontSize: 12, lineHeight: 18, color: palette.muted },
  eval: { marginTop: 4, fontSize: 12, color: palette.danger },
  evidence: { marginTop: 6, maxHeight: 120, backgroundColor: palette.codeBg, borderRadius: 6, padding: 8 },
  evidenceText: { fontSize: 11, color: palette.ink, fontFamily: "Menlo" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  btn: { borderRadius: 8, backgroundColor: palette.primary, paddingHorizontal: 12, paddingVertical: 7 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: palette.line },
  btnText: { fontSize: 12, color: palette.ink },
});
