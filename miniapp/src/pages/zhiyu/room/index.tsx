// 智语房间（openspec: add-zhiyu-mobile-clients 3.3 / 3.4）。
//
// 手机只做四件事：看流（尾部起播 + 上滑翻页）、打字发送、按住说话、看在场。
// 重交互（私窗/邀请/订阅/设置）不在这一页实现——它们各是一枚指向 web 的
// 一次性链接（5.1）。这一页之所以能用同一套语义，是因为读取全部交给
// @platform/core 的 ZhiyuRoomClient（web 和小程序共用），这一页只负责：
//
//   • 一个轮询适配器（createPollingTransport，长轮询 /stream?after=&wait=）；
//   • 一个生命周期驱动（PollDriver：切后台暂停、回前台补读、失败退避）；
//   • 渲染。所有状态迁移都在 @platform/core 的 zhiyu-mobile-model（纯函数，node 可测）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow, useRouter } from "@tarojs/taro";
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
  initialScreen,
  isRenderableRow,
  PollDriver,
  presenceLine,
  setDraft,
  setRecording,
  syncFailures,
  transcriptIntoDraft,
  VoiceRecorder,
  ZhiyuRoomClient,
  http,
  type RoomScreenState,
} from "@platform/core";
import PageHeader from "@/components/PageHeader";
import { mintHandoff, getRoom, sendMessage, type ZhiyuMemberRow, type ZhiyuRoomSummary } from "@/lib/zhiyu-api";
import { taroRecorder, uploadTake, type MiniTake } from "@/lib/recorder-taro";

/** The web-only surfaces this page hands off instead of implementing (5.1). */
const HANDOFFS: { purpose: string; label: string }[] = [
  { purpose: "private_window", label: "私窗" },
  { purpose: "invite", label: "邀请成员" },
  { purpose: "subscription", label: "团队订阅" },
];

export default function ZhiyuRoomPage() {
  const router = useRouter();
  const roomId = router.params.roomId ?? "";
  const [screen, setScreen] = useState<RoomScreenState>(() => initialScreen(roomId));
  const [room, setRoom] = useState<ZhiyuRoomSummary | null>(null);
  const [members, setMembers] = useState<ZhiyuMemberRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<string>("idle");
  const [handoffNote, setHandoffNote] = useState<string | null>(null);

  const screenRef = useRef(screen);
  screenRef.current = screen;
  const draftRef = useRef("");
  draftRef.current = screen.draft;
  const driverRef = useRef<PollDriver | null>(null);

  const patch = useCallback((fn: (s: RoomScreenState) => RoomScreenState) => {
    setScreen((prev) => fn(prev));
  }, []);

  // ── room meta ────────────────────────────────────────────────────────────
  const loadRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const d = await getRoom(roomId);
      setRoom(d.room);
      setMembers(d.members ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message || "读取房间失败");
    }
  }, [roomId]);

  useEffect(() => {
    void loadRoom();
  }, [loadRoom]);

  // ── the shared state machine over the polling transport ──────────────────
  useEffect(() => {
    if (!roomId) return;
    const transport = createPollingTransport({
      roomId,
      request: (path, init) => http(path, init),
    });
    const client = new ZhiyuRoomClient({ transport, roomId, tailCount: 30, pageSize: 20 });
    const driver = new PollDriver({
      client,
      holdMs: holdFor(screenRef.current.transport),
      // The driver owns the failure count; the screen only translates it into
      // the readable mode (and back — a success restores the long poll).
      onState: (_state, meta) => {
        patch((s) => syncFailures(s, meta.failures));
      },
    });
    driverRef.current = driver;
    const unsubscribe = client.subscribe((state) => {
      if (state.error) {
        // A failed read is a blip until it repeats — the model decides when the
        // cadence change becomes worth telling the user about (3.4).
        patch((s) => syncFailures(s, driver.failureCount));
        return;
      }
      patch((s) => applyIncoming(s, { messages: state.messages as never, cursor: state.cursor }));
    });
    void driver.start().catch(() => {
      patch((s) => syncFailures(s, driver.failureCount));
    });
    return () => {
      unsubscribe();
      driver.stop();
      driverRef.current = null;
    };
  }, [roomId, patch]);

  // Keep the transport's cadence equal to what the screen is showing.
  useEffect(() => {
    driverRef.current?.setHold(holdFor(screen.transport));
  }, [screen.transport]);

  // ── lifecycle: a phone in a pocket is not a subscriber (4.3) ─────────────
  useDidHide(() => {
    driverRef.current?.pause();
  });
  useDidShow(() => {
    // Catch up, do not just increment: minutes away can be many pages.
    void driverRef.current?.resume();
    void loadRoom();
  });

  // ── actions ──────────────────────────────────────────────────────────────
  const loadEarlier = useCallback(async () => {
    const driver = driverRef.current;
    if (!driver || screenRef.current.loadingOlder) return;
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
      // The text stays: losing a sentence to a network blip is worse than a
      // duplicate the user can see.
      patch((s) => applySendFailed(s, (err as Error).message || "发送失败"));
    }
  }, [roomId, patch]);

  // ── hold-to-talk (reuses the same adapter as the chat page) ──────────────
  const voiceRef = useRef<VoiceRecorder<MiniTake> | null>(null);
  if (voiceRef.current === null) {
    voiceRef.current = new VoiceRecorder<MiniTake>({
      adapter: taroRecorder(),
      upload: (take) => uploadTake(take),
      insert: (text) => {
        const next = composeTranscript(draftRef.current, text);
        if (next === null) return;
        // Transcription lands in the composer for editing; it is never sent
        // automatically (add-voice-input spec: 说完可改再发).
        patch((s) => transcriptIntoDraft(s, text));
      },
      autoStopMs: 600_000,
      onPhase: (phase) => setVoicePhase(phase),
    });
  }
  const voice = voiceRef.current;

  useEffect(() => {
    const recording = voicePhase === "recording";
    if (recording !== screenRef.current.recording) {
      patch((s) => setRecording(s, recording));
    }
  }, [voicePhase, patch]);

  // ── hand-off: a one-time link, copied to the clipboard (5.1/5.2) ─────────
  const handoff = useCallback(
    async (purpose: string, label: string) => {
      try {
        const link = await mintHandoff(roomId, purpose);
        await Taro.setClipboardData({ data: link.url });
        setHandoffNote(`${label}在电脑上打开，链接已复制（只能用一次）`);
      } catch (err) {
        setHandoffNote(`${label}链接生成失败：${(err as Error).message}`);
      }
    },
    [roomId],
  );

  const visibleRows = useMemo(() => screen.rows.filter(isRenderableRow), [screen.rows]);
  const note = connectionNote(screen.transport);
  const presence = useMemo(
    () => presenceLine(members.map((m) => ({ id: m.id, display: m.display, kind: m.kind, presence: m.presence }))),
    [members],
  );

  return (
    <View data-testid="mp-zhiyu-room" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <PageHeader title={room?.title || "空间"} />

      {note ? (
        <Text data-testid="mp-zy-connection-note" style={{ padding: "6px 16px", fontSize: "12px", color: "#8a6d3b" }}>
          {note}
        </Text>
      ) : null}
      {handoffNote ? (
        <Text data-testid="mp-zy-handoff-note" style={{ padding: "6px 16px", fontSize: "12px", color: "#31708e" }}>
          {handoffNote}
        </Text>
      ) : null}
      {loadError ? (
        <Text data-testid="mp-zy-load-error" style={{ padding: "6px 16px", fontSize: "12px", color: "#c0392b" }}>
          {loadError}
        </Text>
      ) : null}

      <ScrollView scrollY style={{ flex: 1, minHeight: 0, padding: "12px 16px" }}>
        {screen.hasOlder ? (
          <Text
            data-testid="mp-zy-load-earlier"
            onClick={() => void loadEarlier()}
            style={{ display: "block", textAlign: "center", color: "var(--muted-foreground, #888)", fontSize: "13px", padding: "8px 0" }}
          >
            {screen.loadingOlder ? "正在读取…" : "加载更早"}
          </Text>
        ) : null}
        {visibleRows.map((row) => (
          <View
            key={row.seq}
            data-testid={`mp-zy-msg-${row.seq}`}
            style={{
              marginBottom: "10px",
              display: "flex",
              justifyContent: row.kind === "agent" ? "flex-start" : "flex-end",
            }}
          >
            <Text
              style={{
                maxWidth: "80%",
                padding: "8px 10px",
                borderRadius: "8px",
                background: row.kind === "agent" ? "var(--muted, #f3f3f3)" : "#dbeafe",
                fontSize: "15px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {row.content}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Read-only presence strip: mobile shows who is here, it does not manage seats. */}
      <Text data-testid="mp-zy-presence" style={{ padding: "4px 16px", fontSize: "12px", color: "var(--muted-foreground, #888)" }}>
        {presence}
      </Text>

      <View style={{ display: "flex", gap: "8px", padding: "8px 16px 16px", alignItems: "center" }}>
        <Input
          data-testid="mp-zy-composer"
          value={screen.draft}
          onInput={(e) => patch((s) => setDraft(s, e.detail.value))}
          placeholder="说点什么…"
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--border, #ddd)", borderRadius: "8px", padding: "8px 10px" }}
        />
        <Text
          data-testid="mp-zy-talk"
          onTouchStart={() => void voice.start()}
          onTouchEnd={() => void voice.stop()}
          onTouchCancel={() => void voice.cancel()}
          style={{ padding: "8px 10px", borderRadius: "8px", background: screen.recording ? "#c0392b" : "var(--muted, #f3f3f3)" }}
        >
          {screen.recording ? "松开发送" : "按住说话"}
        </Text>
        <Text
          data-testid="mp-zy-send"
          onClick={() => void send()}
          style={{
            padding: "8px 12px",
            borderRadius: "8px",
            background: canSend(screen) ? "#2563eb" : "var(--muted, #eee)",
            color: canSend(screen) ? "#fff" : "var(--muted-foreground, #999)",
          }}
        >
          {screen.sending ? "发送中" : "发送"}
        </Text>
      </View>

      {/* The heavy interactions leave the app through a one-time link (5.1). */}
      <View style={{ display: "flex", gap: "12px", padding: "0 16px 16px" }}>
        {HANDOFFS.map((h) => (
          <Text
            key={h.purpose}
            data-testid={`mp-zy-handoff-${h.purpose}`}
            onClick={() => void handoff(h.purpose, h.label)}
            style={{ fontSize: "12px", color: "#31708e" }}
          >
            {h.label}（电脑上完成）
          </Text>
        ))}
      </View>
    </View>
  );
}
