// CaptureEntry — the mini-program's minimal 「长录音」 surface (openspec:
// add-voice-capture-lane, task 5.4).
//
// Scope on purpose: start / one-line progress / stop-and-merge. The full
// per-slice reading, correction and export live on the web; the phone's job is
// to get the meeting home without dying at the 25 MB single-take ceiling.
//
// Recording is slice-by-slice through the existing recorder adapter: each take
// is one 30s temp file, uploaded immediately, so text starts arriving while the
// meeting is still going and a failed slice costs 30 seconds, not the meeting.
// The gap between takes (~a few hundred ms of stop/start) is a real limitation
// of this minimal surface — see the device-only notes in the change report.
//
// Slicing and retry decisions come from the shared uploader (which imports
// @platform/core); this file only wires Taro + the recorder.

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, refreshToken } from "@/lib/auth";
import { baseUrl } from "@/lib/config";
import {
  createCaptureUploader,
  type CaptureState,
  type CaptureUpload,
  type CaptureUploadRequest,
  type CaptureUploadResponse,
} from "@/lib/capture-upload";
import { taroRecorder } from "@/lib/recorder-taro";

const SLICE_MS = 30_000;
// A take shorter than this is a stop landing before any audio: dropping it
// avoids paying to transcribe 200ms of silence.
const MIN_SLICE_MS = 500;

function parseBody(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

/** Taro.request / Taro.uploadFile behind the uploader's transport contract. */
function createTaroTransport(): CaptureUpload {
  const api = () => baseUrl().replace(/\/+$/, "");

  const postJson = async (path: string, data: Record<string, unknown>): Promise<CaptureUploadResponse> => {
    const send = () =>
      Taro.request({
        url: `${api()}${path}`,
        method: "POST",
        header: { ...authHeaders(), "content-type": "application/json" },
        data,
      });
    let res = await send();
    // One silent re-login on a lapsed token, exactly like the composer lane.
    if (res.statusCode === 401 && (await refreshToken())) res = await send();
    return { status: res.statusCode, body: parseBody(res.data) };
  };

  const postChunk = async (req: CaptureUploadRequest): Promise<CaptureUploadResponse> => {
    const send = () =>
      Taro.uploadFile({
        url: `${api()}/api/voice/captures/${req.captureId}/chunks`,
        filePath: String(req.filePath ?? ""),
        name: "file",
        header: authHeaders(),
        formData: {
          seq: String(req.seq),
          start_ms: String(req.startMs),
          duration_ms: String(req.durationMs),
        },
      });
    let res = await send();
    if (res.statusCode === 401 && (await refreshToken())) res = await send();
    return { status: res.statusCode, body: parseBody(res.data) };
  };

  return async (req) => {
    if (req.op === "chunk") return postChunk(req);
    if (req.op === "create") return postJson("/api/voice/captures", { title: req.title ?? "" });
    if (req.op === "finish") return postJson(`/api/voice/captures/${req.captureId}/finish`, {});
    return postJson(`/api/voice/captures/${req.captureId}/abandon`, {});
  };
}

const panelStyle = {
  margin: "0 0 12px",
  padding: "16px 22px",
  borderRadius: "16px",
  background: "#eef2ff",
  display: "flex",
  alignItems: "center",
  gap: "16px",
};

export function CaptureEntry({
  available,
  onActiveChange,
}: {
  available: boolean;
  /** Lets the page mute the hold-to-talk mic while a capture owns the recorder. */
  onActiveChange?: (active: boolean) => void;
}) {
  const uploader = useMemo(
    () =>
      createCaptureUploader({
        upload: createTaroTransport(),
        platform: { name: "miniapp", sliceMs: SLICE_MS },
      }),
    [],
  );
  const [snapshot, setSnapshot] = useState<CaptureState>(() => uploader.getState());
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => uploader.subscribe(setSnapshot), [uploader]);

  const recorder = useRef<ReturnType<typeof taroRecorder> | null>(null);
  if (recorder.current === null) recorder.current = taroRecorder();
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
    const rec = recorder.current;
    if (!rec) return;
    while (running.current) {
      const mine = seq.current;
      try {
        await rec.start();
      } catch (e) {
        setError((e as Error).message || "录音启动失败");
        break;
      }
      await waitSlice();
      const take = await rec.stop();
      if (!take || take.empty || take.durationMs < MIN_SLICE_MS) {
        if (!running.current) break;
        emptyTakes.current += 1;
        // A recorder that keeps producing nothing would spin here; give up
        // after three in a row instead of hammering start/stop forever.
        if (emptyTakes.current >= 3) {
          setError("没有录到声音，已停止");
          break;
        }
        continue; // nothing captured — retry this seq instead of advancing
      }
      emptyTakes.current = 0;
      const result = await uploader.uploadSlice(
        mine,
        mine * SLICE_MS,
        take.durationMs,
        take.artifact.filePath,
      );
      seq.current = mine + 1;
      if (result.stopped) {
        setError("已达转写预算上限，后续分片只暂存");
        break;
      }
    }
    running.current = false;
    onActiveChange?.(false);
    if (seq.current > 0) await uploader.finishCapture();
  }

  async function start() {
    const rec = recorder.current;
    if (!rec || running.current || starting.current) return;
    starting.current = true;
    setError("");
    setDismissed(false);
    try {
      const granted = await rec.requestPermission();
      if (!granted) {
        setError("麦克风权限被拒绝，请在设置中允许录音");
        return;
      }
      const created = await uploader.startCapture({ title: "长录音" });
      if (created.status === "error") {
        setError(created.error || "发起长录音失败");
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
      void recorder.current?.cancel();
      if (uploader.getState().status === "recording") void uploader.abandonCapture();
    },
    [onActiveChange, uploader],
  );

  if (!available) return null;

  const state = snapshot;
  const active = state.status === "recording";
  const pending = state.pending;
  const minutes = Math.floor(state.progress.transcribedMinutes);
  const showEntry = !active && (state.status !== "finished" || dismissed);

  return (
    <View>
      {showEntry ? (
        <View style={panelStyle} aria-label="长录音" onClick={() => void start()}>
          <Text style={{ fontSize: "26px", color: "#334155" }}>🎙 长录音</Text>
          <Text style={{ fontSize: "22px", color: "#64748b" }}>会议 / 课程，边录边转写</Text>
        </View>
      ) : null}

      {active ? (
        <View style={panelStyle}>
          <Text style={{ flex: 1, fontSize: "24px", color: "#334155" }}>
            已转写 {minutes} 分钟 / {state.progress.total} 片
          </Text>
          {pending > 0 ? (
            <Text
              style={{ fontSize: "24px", color: "#4f46e5", padding: "0 12px" }}
              onClick={() => void uploader.retryPending()}
            >
              重试 {pending} 片
            </Text>
          ) : null}
          <Text style={{ fontSize: "24px", color: "#dc2626" }} onClick={stop}>
            停止并整理
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={{ ...panelStyle, background: "#fef2f2" }}>
          <Text style={{ flex: 1, fontSize: "24px", color: "#b91c1c" }}>{error}</Text>
        </View>
      ) : null}

      {state.status === "finished" && !dismissed ? (
        <View style={{ ...panelStyle, display: "block" }}>
          <View style={{ display: "flex", alignItems: "center", marginBottom: "12px" }}>
            <Text style={{ flex: 1, fontSize: "24px", color: "#334155" }}>转写结果</Text>
            <Text style={{ fontSize: "24px", color: "#4f46e5" }} onClick={() => setDismissed(true)}>
              关闭
            </Text>
          </View>
          <ScrollView scrollY style={{ maxHeight: "360px" }}>
            <Text style={{ fontSize: "24px", color: "#1f2937", whiteSpace: "pre-wrap" }}>
              {state.text || "（没有识别到文字）"}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
