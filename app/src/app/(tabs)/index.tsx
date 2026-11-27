// The chat tab (task 3.2): connection banner, three-zone header (history /
// combined model·persona chip / new session), the streaming transcript with
// welcome prompts on the empty state, the question card gate, and the card
// composer (send / stop). Protocol + state machine come from @platform/core
// through the session runtime — this file is rendering + input only.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { composeTranscript, http, useChatStore, type Turn } from "@platform/core";
import * as DocumentPicker from "expo-document-picker";
import { TurnView } from "@/components/TurnView";
import { QuestionCard } from "@/components/QuestionCard";
import { CaptureEntry } from "@/components/CaptureEntry";
import { HistoryDrawer } from "@/components/HistoryDrawer";
import { SelectionPanel } from "@/components/SelectionPanel";
import { palette } from "@/components/palette";
import { runtime, bindRouter } from "@/lib/session";
import { useExpoVoiceRecorder } from "@/lib/recorder-expo";
import { useAppStore } from "@/store/app-store";
import { useTranslation } from "react-i18next";

// Welcome prompts resolve through i18n so both locales carry them.
const PROMPTS = [
  { title: "welcome.skills", text: "welcome.skillsText" },
  { title: "welcome.verify", text: "welcome.verifyText" },
  { title: "welcome.write", text: "welcome.writeText" },
];

export default function ChatScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const status = useChatStore((s) => s.status);
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const currentModel = useChatStore((s) => s.currentModel);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const agents = useChatStore((s) => s.agents);
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const lastChatError = useAppStore((s) => s.lastChatError);
  const clearChatError = useAppStore((s) => s.clearChatError);

  const [draft, setDraft] = useState("");

  // Voice input (openspec: add-voice-input-mobile): hold to talk, release to
  // transcribe into the draft, slide up to cancel. The phases and every side
  // effect come from the shared machine — this screen only renders them.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [voicePhase, setVoicePhase] = useState<"idle" | "recording" | "transcribing" | "error">("idle");
  // Voice availability is the SERVER's answer (voice-lane /api/voice/status):
  // a deployment with the lane disabled must show no entry at all, so the mic
  // is gated on it rather than on the recorder alone. Unreachable reads as
  // unavailable — an entry that always fails is worse than no entry.
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  // Long recording owns the recorder while it runs; the hold-to-talk mic is
  // muted meanwhile (one audio recorder at a time).
  const [captureActive, setCaptureActive] = useState(false);
  useEffect(() => {
    let alive = true;
    http("/api/voice/status")
      .then((r) => r.json())
      .then((body) => {
        if (alive) setVoiceAvailable(Boolean((body as { available?: boolean })?.available));
      })
      .catch(() => {
        if (alive) setVoiceAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const voice = useExpoVoiceRecorder({
    insert: (text) => {
      const next = composeTranscript(draftRef.current, text);
      // Never auto-send: the transcript only lands in the draft.
      if (next !== null) setDraft(next);
    },
    tooLargeMessage: t("chat.voiceTooLarge"),
  });
  useEffect(() => voice.subscribe((phase) => setVoicePhase(phase === "requesting" ? "idle" : phase)), [voice]);
  // Unmount mid-take: release the microphone and drop the take.
  useEffect(() => () => void voice.cancel(), [voice]);
  const micStartY = useRef<number | null>(null);
  const micCancelled = useRef(false);
  const [attachments, setAttachments] = useState<{ key: number; id: string; name: string; state: "uploading" | "attached" | "error" }[]>([]);
  const attachSeq = useRef(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const listRef = useRef<FlatList<Turn>>(null);

  useEffect(() => {
    bindRouter(router);
    void runtime.boot();
  }, [router]);

  // Follow the stream: scroll to the newest content.
  useEffect(() => {
    if (turns.length) listRef.current?.scrollToEnd({ animated: true });
  }, [turns.length, turns[turns.length - 1]]);

  const send = useCallback(() => {
    const attached = attachments.filter((a) => a.state === "attached");
    const text = draft.trim();
    if ((!text && attached.length === 0) || isStreaming || pendingQuestion) return;
    // @doc references ride the prompt text — the server's ingestion contract.
    const refs = attached.map((a) => `@doc:${a.id}`).join(" ");
    const full = [text, refs].filter(Boolean).join(" ");
    if (runtime.send({ type: "prompt", text: full })) {
      setDraft("");
      setAttachments([]);
    }
  }, [draft, attachments, isStreaming, pendingQuestion]);

  // Attach: pick → upload through the documents endpoint → chip until sent.
  const attach = useCallback(async () => {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return;
    const file = picked.assets?.[0];
    if (!file) return;
    const key = ++attachSeq.current;
    setAttachments((a) => [...a, { key, id: "", name: file.name ?? t("chat.fileDefault"), state: "uploading" }]);
    try {
      const fd = new FormData();
      fd.append("file", { uri: file.uri, name: file.name ?? "file", type: file.mimeType ?? "application/octet-stream" } as unknown as Blob);
      const res = await http("/api/documents", { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
      if (res.ok && body.id) {
        setAttachments((a) => a.map((x) => (x.key === key ? { ...x, id: body.id!, name: body.name || x.name, state: "attached" } : x)));
      } else {
        setAttachments((a) => a.map((x) => (x.key === key ? { ...x, state: "error" } : x)));
      }
    } catch {
      setAttachments((a) => a.map((x) => (x.key === key ? { ...x, state: "error" } : x)));
    }
  }, [t]);

  const stop = useCallback(() => {
    useChatStore.getState().stopStreaming();
  }, []);

  const regenerate = useCallback(() => {
    const lastUser = [...turns].reverse().find((x) => x.role === "user");
    if (lastUser && !isStreaming) runtime.send({ type: "prompt", text: lastUser.text });
  }, [turns, isStreaming]);

  const agentName = agents.find((a) => a.id === currentAgent)?.name;
  const chip = [agentName, currentModel].filter(Boolean).join(" · ") || t("chat.placeholderTitle");

  const key = (item: Turn, index: number) => `${item.id}-${index}`;
  const renderItem = ({ item, index }: { item: Turn; index: number }) => (
    <View>
      <TurnView turn={item} />
      {/* Regenerate rides under the LAST assistant turn while idle. */}
      {index === turns.length - 1 && item.role === "assistant" && !isStreaming && !pendingQuestion && turns.some((x) => x.role === "user") && (
        <Pressable style={styles.regenButton} onPress={regenerate}>
          <Text style={styles.regenText}>↻ {t("chat.regenerate")}</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {/* Header: history / selection chip / new session */}
      <View style={styles.header}>
        <Pressable style={styles.headerButton} onPress={() => setHistoryOpen(true)}>
          <Text style={styles.headerGlyph}>☰</Text>
        </Pressable>
        <Pressable style={styles.chip} onPress={() => setPanelOpen(true)}>
          <Text style={styles.chipText} numberOfLines={1}>
            {chip}
          </Text>
          <Text style={styles.chipCaret}>▾</Text>
        </Pressable>
        <Pressable
          style={styles.headerButton}
          onPress={() => runtime.send({ type: "new_session" })}
        >
          <Text style={styles.headerGlyph}>＋</Text>
        </Pressable>
        <Pressable style={styles.headerButton} testID="settings-entry" onPress={() => router.push("/settings")}>
          <Text style={styles.headerGlyph}>⚙</Text>
        </Pressable>
      </View>

      {/* Connection / error banner */}
      {(status !== "connected" || lastChatError) && (
        <Pressable
          style={[styles.banner, status === "connected" ? styles.bannerWarn : styles.bannerDown]}
          onPress={() => {
            clearChatError();
            runtime.reconnectNow();
          }}
        >
          <Text style={styles.bannerText}>
            {status === "connected" && lastChatError
              ? lastChatError
              : status === "connecting"
                ? t("gate.connecting")
                : `${t("chat.disconnected")} · ${t("chat.reconnect")}`}
          </Text>
        </Pressable>
      )}

      {/* Transcript */}
      {turns.length === 0 ? (
        <View style={styles.welcome}>
          <Text style={styles.welcomeTitle}>{t("chat.placeholderTitle")}</Text>
          {PROMPTS.map((p) => (
            <Pressable key={p.title} style={styles.promptCard} onPress={() => setDraft(t(p.text))}>
              <Text style={styles.promptTitle}>{t(p.title)}</Text>
              <Text style={styles.promptBody} numberOfLines={2}>
                {t(p.text)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={turns}
          extraData={turns}
          keyExtractor={key}
          renderItem={renderItem}
          contentContainerStyle={styles.transcript}
        />
      )}

      {/* Pending ask gates the composer (add-user-questions parity). */}
      {pendingQuestion && (
        <QuestionCard
          askId={pendingQuestion.askId}
          questions={pendingQuestion.questions}
          onSubmit={(msg) => runtime.send(msg)}
        />
      )}

      {/* Composer */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        {/* Long recording (add-voice-capture-lane, 5.4): starts a 30s-slice
            capture, shows one progress line, merges on stop. Gated on the same
            server answer as the mic. */}
        <CaptureEntry available={voiceAvailable} onActiveChange={setCaptureActive} />
        <View style={[styles.composer, { marginBottom: insets.bottom }]}>
          {attachments.length > 0 && (
            <View style={styles.attachRow}>
              {attachments.map((a) => (
                <Pressable
                  key={a.key}
                  style={[styles.attachChip, a.state === "error" && { borderColor: palette.danger }]}
                  onPress={() => setAttachments((x) => x.filter((y) => y.key !== a.key))}
                >
                  <Text style={styles.attachText} numberOfLines={1}>
                    {a.state === "uploading" ? "⏳ " : a.state === "error" ? "✕ " : "📎 "}
                    {a.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable style={styles.attachButton} onPress={() => void attach()} accessibilityLabel={t("chat.attach")} disabled={isStreaming || Boolean(pendingQuestion)}>
            <Text style={styles.attachGlyph}>📎</Text>
          </Pressable>
          {/* Hold to talk (add-voice-input-mobile): press starts, release
              transcribes into the draft, sliding up cancels. The five phases
              come from the shared machine; this control only reports them. */}
          {voiceAvailable && voice.canRecord() && !captureActive ? (
            <Pressable
              testID="composer-mic"
              style={[styles.attachButton, voicePhase === "recording" && styles.micActive]}
              accessibilityLabel={voicePhase === "recording" ? t("chat.voiceRelease") : t("chat.voiceHold")}
              accessibilityState={{ busy: voicePhase === "transcribing" }}
              onPressIn={() => {
                micCancelled.current = false;
                micStartY.current = null;
                void voice.start();
              }}
              onPressOut={() => {
                if (micCancelled.current) return;
                void voice.stop();
              }}
              onTouchMove={(e) => {
                const y = e.nativeEvent.locationY;
                if (micStartY.current === null) micStartY.current = y;
                if (micStartY.current - y >= 40 && !micCancelled.current) {
                  micCancelled.current = true;
                  void voice.cancel();
                }
              }}
            >
              <Text style={styles.attachGlyph}>{voicePhase === "recording" ? "●" : "🎤"}</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={styles.input}
            testID="composer-input"
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder={pendingQuestion ? t("chat.gatedPlaceholder") : t("chat.placeholder")}
            placeholderTextColor={palette.muted}
            editable={!isStreaming && !pendingQuestion}
          />
          {isStreaming ? (
            <Pressable style={styles.stopButton} onPress={stop} accessibilityLabel={t("chat.stop")}>
              <Text style={styles.stopGlyph}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="send-button"
              style={[styles.sendButton, (!draft.trim() && attachments.every((a) => a.state !== "attached")) || pendingQuestion ? styles.disabled : null]}
              disabled={(!draft.trim() && attachments.every((a) => a.state !== "attached")) || Boolean(pendingQuestion)}
              onPress={send}
            >
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          )}
          {voicePhase === "recording" || voicePhase === "transcribing" || voicePhase === "error" ? (
            <Pressable
              testID="composer-voice-state"
              style={[styles.voiceChip, voicePhase === "error" && styles.voiceChipError]}
              onPress={() => {
                if (voicePhase === "error") voice.dismissError();
              }}
              disabled={voicePhase !== "error"}
            >
              <Text style={styles.voiceChipText} numberOfLines={2}>
                {voicePhase === "recording"
                  ? t("chat.voiceRecording")
                  : voicePhase === "transcribing"
                    ? t("chat.voiceTranscribing")
                    : voice.failure()?.message || t("chat.voiceFailed")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>

      <HistoryDrawer
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSwitch={(id) => {
          runtime.send({ type: "switch_session", id });
          setHistoryOpen(false);
        }}
        onNewSession={() => {
          runtime.send({ type: "new_session" });
          setHistoryOpen(false);
        }}
      />
      <SelectionPanel
        visible={panelOpen}
        onClose={() => setPanelOpen(false)}
        onSetModel={(id) => runtime.send({ type: "set_model", id })}
        onSetAgent={(id) => runtime.send({ type: "set_agent", id })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.paper },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    backgroundColor: palette.card,
  },
  headerButton: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  headerGlyph: { fontSize: 20, color: palette.ink },
  chip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  chipText: { fontSize: 13, color: palette.ink, maxWidth: "85%" },
  chipCaret: { fontSize: 11, color: palette.muted },
  banner: { paddingVertical: 7, paddingHorizontal: 14 },
  bannerDown: { backgroundColor: palette.danger + "18" },
  bannerWarn: { backgroundColor: "#B08800" + "18" },
  bannerText: { color: palette.ink, fontSize: 12.5, textAlign: "center" },
  welcome: { flex: 1, padding: 20, gap: 10, justifyContent: "center" },
  welcomeTitle: { fontSize: 24, fontWeight: "700", color: palette.ink, textAlign: "center", marginBottom: 8 },
  promptCard: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  promptTitle: { fontSize: 15, fontWeight: "600", color: palette.ink },
  promptBody: { fontSize: 13, color: palette.muted, lineHeight: 18 },
  transcript: { paddingHorizontal: 14, paddingVertical: 10 },
  regenButton: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: palette.line, marginTop: 2, marginBottom: 6 },
  regenText: { fontSize: 12.5, color: palette.muted },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    backgroundColor: palette.card,
  },
  attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  attachChip: { borderWidth: 1, borderColor: palette.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: palette.paper },
  attachText: { fontSize: 12, color: palette.ink, maxWidth: 140 },
  attachButton: { width: 38, height: 40, alignItems: "center", justifyContent: "center" },
  attachGlyph: { fontSize: 17 },
  micActive: { backgroundColor: palette.danger, borderRadius: 20 },
  voiceChip: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  voiceChipError: { borderColor: palette.danger },
  voiceChipText: { fontSize: 12, color: palette.ink },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.paper,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: palette.ink,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: palette.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
  sendGlyph: { color: "#fff", fontSize: 18, fontWeight: "700" },
  stopButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: palette.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  stopGlyph: { color: "#fff", fontSize: 14 },
});
