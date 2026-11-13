// 智语房间（openspec: add-zhiyu-mobile-clients 4.1 / 4.2 / 3.3 / 3.4 on the app）。
//
// 与小程序**同一个**状态机与**同一套**状态迁移（`@platform/core` 的
// ZhiyuRoomClient + PollDriver + zhiyu-mobile-model），差别只在适配器与渲染：
// 这里用 RN 的 fetch（platform.wireCore 已把 core 的 http 指到它）与 RN 组件。
// 如果这一页开始自己算游标或自己决定失败后草稿怎么办，就是三端开始分叉了。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import {
  applyIncoming,
  applyOlder,
  applySent,
  applySendFailed,
  beginLoadingOlder,
  canSend,
  composeTranscript,
  connectionNote,
  createPollingTransport,
  holdFor,
  http,
  initialScreen,
  isRenderableRow,
  PollDriver,
  presenceLine,
  setDraft,
  setRecording,
  syncFailures,
  transcriptIntoDraft,
  ZhiyuRoomClient,
  type RoomScreenState,
} from "@platform/core";
import { palette } from "@/components/palette";
import { useExpoVoiceRecorder } from "@/lib/recorder-expo";
import { getRoom, mintHandoff, sendMessage, type ZhiyuMemberRow, type ZhiyuRoomSummary } from "@/lib/zhiyu-api";

const HANDOFFS = ["private_window", "invite", "subscription"] as const;

export default function ZhiyuRoomScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { roomId = "" } = useLocalSearchParams<{ roomId?: string }>();
  const [screen, setScreen] = useState<RoomScreenState>(() => initialScreen(roomId));
  const [room, setRoom] = useState<ZhiyuRoomSummary | null>(null);
  const [members, setMembers] = useState<ZhiyuMemberRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState("idle");

  const screenRef = useRef(screen);
  screenRef.current = screen;
  const draftRef = useRef("");
  draftRef.current = screen.draft;
  const driverRef = useRef<PollDriver | null>(null);

  const patch = useCallback((fn: (s: RoomScreenState) => RoomScreenState) => setScreen((prev) => fn(prev)), []);

  const loadRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const d = await getRoom(roomId);
      setRoom(d.room);
      setMembers(d.members ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message || t("zhiyu.loadFailed"));
    }
  }, [roomId, t]);

  useEffect(() => {
    void loadRoom();
  }, [loadRoom]);

  useEffect(() => {
    if (!roomId) return;
    const transport = createPollingTransport({ roomId, request: (path, init) => http(path, init) });
    const client = new ZhiyuRoomClient({ transport, roomId, tailCount: 30, pageSize: 20 });
    const driver = new PollDriver({
      client,
      holdMs: holdFor(screenRef.current.transport),
      onState: (_state, meta) => patch((s) => syncFailures(s, meta.failures)),
    });
    driverRef.current = driver;
    const unsubscribe = client.subscribe((state) => {
      if (state.error) {
        patch((s) => syncFailures(s, driver.failureCount));
        return;
      }
      patch((s) => applyIncoming(s, { messages: state.messages as never, cursor: state.cursor }));
    });
    void driver.start().catch(() => patch((s) => syncFailures(s, driver.failureCount)));
    return () => {
      unsubscribe();
      driver.stop();
      driverRef.current = null;
    };
  }, [roomId, patch]);

  useEffect(() => {
    driverRef.current?.setHold(holdFor(screen.transport));
  }, [screen.transport]);

  const loadEarlier = useCallback(async () => {
    if (screenRef.current.loadingOlder) return;
    patch(beginLoadingOlder);
    const before = screenRef.current.rows[0]?.seq;
    if (!before) {
      patch((s) => applyOlder(s, { messages: [] }));
      return;
    }
    try {
      const res = await http(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/messages?before=${before}&limit=20`);
      const body = await res.json().catch(() => null);
      patch((s) => applyOlder(s, { messages: (body?.messages ?? []) as never }));
    } catch {
      patch((s) => applyOlder(s, { messages: [] }));
    }
  }, [roomId, patch]);

  const send = useCallback(async () => {
    const current = screenRef.current;
    if (!canSend(current)) return;
    const text = current.draft.trim();
    patch((s) => ({ ...s, sending: true }));
    try {
      await sendMessage(roomId, text);
      patch(applySent);
    } catch (err) {
      // The text stays: losing a sentence to a blip is worse than a duplicate.
      patch((s) => applySendFailed(s, (err as Error).message || t("zhiyu.sendFailed")));
    }
  }, [roomId, patch, t]);

  const voice = useExpoVoiceRecorder({
    insert: (text) => {
      const next = composeTranscript(draftRef.current, text);
      if (next === null) return;
      // Transcription lands in the composer for editing; never auto-sent.
      patch((s) => transcriptIntoDraft(s, text));
    },
    tooLargeMessage: t("chat.voiceTooLarge"),
  });
  useEffect(() => voice.subscribe((phase) => setVoicePhase(phase === "requesting" ? "idle" : phase)), [voice]);
  useEffect(() => () => void voice.cancel(), [voice]);
  useEffect(() => {
    const recording = voicePhase === "recording";
    if (recording !== screenRef.current.recording) patch((s) => setRecording(s, recording));
  }, [voicePhase, patch]);

  const handoff = useCallback(
    async (purpose: string) => {
      try {
        const link = await mintHandoff(roomId, purpose);
        await Clipboard.setStringAsync(link.url);
        setNote(t("zhiyu.handoffCopied"));
      } catch (err) {
        setNote(t("zhiyu.handoffFailed", { message: (err as Error).message }));
      }
    },
    [roomId, t],
  );

  const rows = useMemo(() => screen.rows.filter(isRenderableRow), [screen.rows]);
  const connNote = connectionNote(screen.transport);
  const presence = useMemo(
    () => presenceLine(members.map((m) => ({ id: m.id, display: m.display, kind: m.kind, presence: m.presence }))),
    [members],
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.paper, paddingTop: insets.top }}>
      <Text style={styles.title}>{room?.title || t("zhiyu.untitled")}</Text>
      {connNote ? <Text testID="app-zy-conn-note" style={styles.note}>{t("zhiyu.shortPoll")}</Text> : null}
      {note ? <Text testID="app-zy-handoff-note" style={styles.info}>{note}</Text> : null}
      {loadError ? <Text testID="app-zy-load-error" style={styles.error}>{loadError}</Text> : null}

      <FlatList
        testID="app-zy-stream"
        data={rows}
        keyExtractor={(r) => String(r.seq)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
        ListHeaderComponent={
          screen.hasOlder ? (
            <Pressable testID="app-zy-load-earlier" onPress={() => void loadEarlier()}>
              <Text style={{ textAlign: "center", color: palette.muted, paddingVertical: 8 }}>
                {screen.loadingOlder ? t("zhiyu.loading") : t("zhiyu.loadEarlier")}
              </Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            testID={`app-zy-msg-${item.seq}`}
            style={{ marginBottom: 10, alignItems: item.kind === "agent" ? "flex-start" : "flex-end" }}
          >
            <Text
              style={[
                styles.bubble,
                item.kind === "agent" ? { backgroundColor: palette.codeBg } : { backgroundColor: "#DBEAFE" },
              ]}
            >
              {item.content}
            </Text>
          </View>
        )}
      />

      {/* Read-only presence: the app shows who is here, it does not manage seats. */}
      <Text testID="app-zy-presence" style={{ paddingHorizontal: 16, paddingVertical: 4, fontSize: 12, color: palette.muted }}>
        {presence}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
        <TextInput
          testID="app-zy-composer"
          value={screen.draft}
          onChangeText={(v) => patch((s) => setDraft(s, v))}
          placeholder={t("zhiyu.placeholder")}
          placeholderTextColor={palette.muted}
          style={styles.input}
          multiline
        />
        <Pressable
          testID="app-zy-talk"
          onPressIn={() => void voice.start()}
          onPressOut={() => void voice.stop()}
          style={[styles.talk, screen.recording && { backgroundColor: palette.danger }]}
        >
          <Text style={{ color: screen.recording ? "#fff" : palette.ink, fontSize: 12 }}>
            {screen.recording ? t("zhiyu.talkRelease") : t("zhiyu.talk")}
          </Text>
        </Pressable>
        <Pressable
          testID="app-zy-send"
          onPress={() => void send()}
          style={[styles.send, { backgroundColor: canSend(screen) ? palette.primary : palette.line }]}
        >
          <Text style={{ color: canSend(screen) ? "#fff" : palette.muted, fontSize: 12 }}>
            {screen.sending ? t("zhiyu.sending") : t("zhiyu.send")}
          </Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingBottom: 12 }}>
        {HANDOFFS.map((purpose) => (
          <Text
            key={purpose}
            testID={`app-zy-handoff-${purpose}`}
            onPress={() => void handoff(purpose)}
            style={{ fontSize: 12, color: palette.primary }}
          >
            {t(`zhiyu.handoff.${purpose}`)}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: "600", color: palette.ink, paddingHorizontal: 16, paddingVertical: 12 },
  note: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 12, color: "#8A6D3B" },
  info: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 12, color: palette.primary },
  error: { paddingHorizontal: 16, paddingVertical: 6, fontSize: 12, color: palette.danger },
  bubble: { maxWidth: "80%", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, fontSize: 15, color: palette.ink },
  input: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: palette.ink,
    backgroundColor: palette.card,
  },
  talk: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: palette.codeBg },
  send: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
});
