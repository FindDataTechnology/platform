// CaptureEntry — the app's minimal long-recording surface (openspec:
// add-voice-capture-lane, task 5.4).
//
// Scope on purpose: start / one-line progress / stop-and-merge. The full
// per-slice reading, correction and export live on the web; the phone's job is
// to get the meeting home without dying at the 25 MB single-take ceiling.
//
// Recording is slice-by-slice through the existing expo recorder adapter: each
// take is one ~30s temp file, uploaded immediately, so text starts arriving
// while the meeting is still going and a failed slice costs 30 seconds, not the
// meeting. The stop/start gap between takes is a real limitation of this
// minimal surface — see the device-only notes in the change report.
//
// Slicing and retry decisions come from the shared uploader (which imports
// @platform/core); this file only wires expo-audio, core http and i18n.

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { http } from "@platform/core";
import { useTranslation } from "react-i18next";
import {
  createCaptureUploader,
  type CaptureState,
  type CaptureUpload,
  type CaptureUploadRequest,
  type CaptureUploadResponse,
} from "@/lib/capture-upload";
import { createExpoRecorderAdapter, type ExpoRecorderLike } from "@/lib/recorder";
import { runtime } from "@/lib/session";
import { palette } from "@/components/palette";

const SLICE_MS = 30_000;
// A take shorter than this is a stop landing before any audio: dropping it
// avoids paying to transcribe 200ms of silence.
const MIN_SLICE_MS = 500;

/** core http behind the uploader's transport contract, with the one-retry law. */
function createHttpTransport(): CaptureUpload {
  const postJson = async (path: string, body: Record<string, unknown>): Promise<CaptureUploadResponse> => {
    const send = () =>
      http(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let res = await send();
    // A lapsed pairing token: re-exchange silently and retry exactly once.
    if (res.status === 401) {
      await runtime.refresher.refreshOnce();
      res = await send();
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const postChunk = async (req: CaptureUploadRequest): Promise<CaptureUploadResponse> => {
    const send = () => {
      const form = new FormData();
      form.append("seq", String(req.seq));
      form.append("start_ms", String(req.startMs));
      form.append("duration_ms", String(req.durationMs));
      // React Native's FormData takes a file descriptor object (same shape the
      // document-attachment path uses).
      form.append("file", {
        uri: String(req.filePath ?? ""),
        name: `slice-${req.seq}.m4a`,
        type: "audio/m4a",
      } as unknown as Blob);
      return http(`/api/voice/captures/${req.captureId}/chunks`, { method: "POST", body: form });
    };
    let res = await send();
    if (res.status === 401) {
      await runtime.refresher.refreshOnce();
      res = await send();
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  return async (req) => {
    if (req.op === "chunk") return postChunk(req);
    if (req.op === "create") return postJson("/api/voice/captures", { title: req.title ?? "" });
    if (req.op === "finish") return postJson(`/api/voice/captures/${req.captureId}/finish`, {});
    return postJson(`/api/voice/captures/${req.captureId}/abandon`, {});
  };
}

export function CaptureEntry({
  available,
  onActiveChange,
}: {
  available: boolean;
  /** Lets the screen mute the hold-to-talk mic while a capture owns the recorder. */
  onActiveChange?: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const audioRecorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const adapter = useMemo(
    () =>
      createExpoRecorderAdapter({
        recorder: audioRecorder as unknown as ExpoRecorderLike,
        requestPermission: async () => Boolean((await requestRecordingPermissionsAsync())?.granted),
        recordingOptions: RecordingPresets.LOW_QUALITY,
        beforeStart: async () => {
          // iOS records into a silent route without this.
          await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        },
      }),
    [audioRecorder],
  );
  const uploader = useMemo(
    () =>
      createCaptureUploader({
        upload: createHttpTransport(),
        platform: { name: "app", sliceMs: SLICE_MS },
      }),
    [],
  );
  const [snapshot, setSnapshot] = useState<CaptureState>(() => uploader.getState());
  // Error keys, resolved through i18n at render (no CJK literals in app/src).
  const [errorKey, setErrorKey] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => uploader.subscribe(setSnapshot), [uploader]);

  const running = useRef(false);
  const starting = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const seq = useRef(0);
  const emptyTakes = useRef(0);

  // One slice of wall-clock, cut short by the stop button.
  const waitSlice = () =>
    new Promise<void>((resolve) => {
      if (!running.current) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake.current = null;
        resolve();
      }, SLICE_MS);
      wake.current = () => {
        clearTimeout(timer);
        wake.current = null;
        resolve();
      };
    });

  async function loop() {
    while (running.current) {
      const mine = seq.current;
      try {
        await adapter.start();
      } catch {
        setErrorKey("voiceCapture.audioFailed");
        break;
      }
      await waitSlice();
      const take = await adapter.stop();
      if (!take || take.empty || take.durationMs < MIN_SLICE_MS) {
        if (!running.current) break;
        emptyTakes.current += 1;
        // A recorder that keeps producing nothing would spin here; give up
        // after three in a row instead of hammering start/stop forever.
        if (emptyTakes.current >= 3) {
          setErrorKey("voiceCapture.noAudio");
          break;
        }
        continue; // nothing captured — retry this seq instead of advancing
      }
      emptyTakes.current = 0;
      const result = await uploader.uploadSlice(mine, mine * SLICE_MS, take.durationMs, take.artifact.uri);
      seq.current = mine + 1;
      if (result.stopped) {
        setErrorKey("voiceCapture.budget");
        break;
      }
    }
    running.current = false;
    onActiveChange?.(false);
    if (seq.current > 0) await uploader.finishCapture();
  }

  async function start() {
    if (running.current || starting.current) return;
    starting.current = true;
    setErrorKey("");
    setDismissed(false);
    try {
      const granted = await adapter.requestPermission();
      if (!granted) {
        setErrorKey("voiceCapture.denied");
        return;
      }
      const created = await uploader.startCapture({ title: t("voiceCapture.title") });
      if (created.status === "error") {
        setErrorKey("voiceCapture.startFailed");
        return;
      }
      running.current = true;
      seq.current = 0;
      emptyTakes.current = 0;
      onActiveChange?.(true);
      void loop();
    } finally {
      starting.current = false;
    }
  }

  function stop() {
    running.current = false;
    wake.current?.();
  }

  useEffect(
    () => () => {
      running.current = false;
      wake.current?.();
      onActiveChange?.(false);
      void adapter.cancel();
      if (uploader.getState().status === "recording") void uploader.abandonCapture();
    },
    [adapter, onActiveChange, uploader],
  );

  if (!available) return null;

  const state = snapshot;
  const active = state.status === "recording";
  const pending = state.pending;
  const showEntry = !active && (state.status !== "finished" || dismissed);

  return (
    <View style={styles.wrap}>
      {showEntry ? (
        <Pressable testID="capture-entry" style={styles.entry} onPress={() => void start()} accessibilityLabel={t("voiceCapture.entry")}>
          <Text style={styles.entryTitle}>🎙 {t("voiceCapture.entry")}</Text>
          <Text style={styles.entryHint}>{t("voiceCapture.hint")}</Text>
        </Pressable>
      ) : null}

      {active ? (
        <View style={styles.row}>
          <Text style={styles.progress} numberOfLines={1}>
            {t("voiceCapture.progress", {
              minutes: Math.floor(state.progress.transcribedMinutes),
              total: state.progress.total,
            })}
          </Text>
          {pending > 0 ? (
            <Pressable testID="capture-retry" onPress={() => void uploader.retryPending()} accessibilityLabel={t("voiceCapture.retry", { n: pending })}>
              <Text style={styles.retry}>{t("voiceCapture.retry", { n: pending })}</Text>
            </Pressable>
          ) : null}
          <Pressable testID="capture-stop" onPress={stop} accessibilityLabel={t("voiceCapture.stop")}>
            <Text style={styles.stop}>{t("voiceCapture.stop")}</Text>
          </Pressable>
        </View>
      ) : null}

      {errorKey ? (
        <View style={[styles.row, styles.errorRow]}>
          <Text style={styles.error} numberOfLines={2}>
            {t(errorKey)}
          </Text>
        </View>
      ) : null}

      {state.status === "finished" && !dismissed ? (
        <View style={styles.result}>
          <View style={styles.row}>
            <Text style={styles.resultTitle}>{t("voiceCapture.resultTitle")}</Text>
            <Pressable testID="capture-close" onPress={() => setDismissed(true)} accessibilityLabel={t("voiceCapture.close")}>
              <Text style={styles.close}>{t("voiceCapture.close")}</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.resultScroll}>
            <Text style={styles.resultText}>{state.text || t("voiceCapture.empty")}</Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 8 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: palette.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  entryTitle: { fontSize: 14, color: palette.ink, fontWeight: "600" },
  entryHint: { flex: 1, fontSize: 12, color: palette.muted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: palette.codeBg,
    marginBottom: 8,
  },
  progress: { flex: 1, fontSize: 13, color: palette.ink },
  retry: { fontSize: 13, color: palette.primary },
  stop: { fontSize: 13, color: palette.danger, fontWeight: "600" },
  errorRow: { backgroundColor: "#FDECEC" },
  error: { flex: 1, fontSize: 12, color: palette.danger },
  result: { borderRadius: 16, backgroundColor: palette.card, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.line, padding: 12, marginBottom: 8 },
  resultTitle: { flex: 1, fontSize: 14, color: palette.ink, fontWeight: "600" },
  close: { fontSize: 13, color: palette.primary },
  resultScroll: { maxHeight: 220, marginTop: 8 },
  resultText: { fontSize: 13, lineHeight: 20, color: palette.ink },
});
