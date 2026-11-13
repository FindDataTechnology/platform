// capture-upload — long-recording slice planner + uploader for the mini-program
// (openspec: add-voice-capture-lane, 5.4).
//
// The slicing and the retry DECISIONS come from @platform/core
// (voice-capture-slices); this module only drives the transport and owns the
// observable state. A client that planned or retried on its own would produce a
// different transcript for the same meeting than the web — which is exactly what
// the spec forbids.
//
// Deliberately free of `@tarojs/taro`: the transport and the platform facts are
// injected (see CaptureUploadDeps), so node can import this module with a stub
// upload and pin the shared plan (scripts/test-voice-capture-mobile.mjs). The
// Taro binding lives in the UI entry, which builds `upload` from Taro.request /
// Taro.uploadFile.

import {
  CAPTURE_MAX_ATTEMPTS,
  captureComplete,
  captureProgress,
  exportCaptureText,
  pendingSlices,
  planSlices,
  type CaptureProgress,
  type CaptureSlice,
  type SliceState,
} from "@platform/core";

/** The budget gate that stopped transcription (server: 202 `stopped`). */
export type CaptureStop = "minutes" | "usd";

/** One call the uploader asks the client transport to perform. */
export interface CaptureUploadRequest {
  op: "create" | "chunk" | "finish" | "abandon";
  captureId?: string;
  title?: string;
  seq?: number;
  startMs?: number;
  durationMs?: number;
  filePath?: string;
}

export interface CaptureUploadResponse {
  status: number;
  body: unknown;
}

/** Injected transport: Taro on the mini-program, fetch on the app. */
export type CaptureUpload = (req: CaptureUploadRequest) => Promise<CaptureUploadResponse>;

/** Platform facts, injected so importing this module touches no global. */
export interface CapturePlatform {
  /** Diagnostics only — never branched on (both clients run the same plan). */
  name: "miniapp" | "app";
  /** Slice length; the server default is 30s. */
  sliceMs?: number;
  /** Clock, injectable so state changes stay reproducible in a stub test. */
  now?(): number;
}

export interface CaptureUploadDeps {
  upload: CaptureUpload;
  platform: CapturePlatform;
}

/** A merged segment as the server returns it (seq is informational). */
export interface CaptureSegment {
  seq?: number;
  startMs: number;
  text: string;
}

export interface CaptureState {
  captureId: string | null;
  status: "idle" | "recording" | "finished" | "abandoned" | "error";
  /** The plan (from the shared module), ascending by seq. */
  slices: CaptureSlice[];
  chunks: SliceState[];
  progress: CaptureProgress;
  /** Every slice settled (done or out of retries). */
  complete: boolean;
  /** Slices the shared queue still considers retryable (seq-sorted count). */
  pending: number;
  /** Set once the server buffered a slice without transcribing it. */
  stopped: CaptureStop | null;
  segments: CaptureSegment[];
  /** The merged transcript in the shared export shape. */
  text: string;
  /** Last technical failure (the UI localizes the codes it shows). */
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SliceResult {
  seq: number;
  ok: boolean;
  /** True when the local gate (budget stopped) refused to send at all. */
  skipped?: boolean;
  duplicate?: boolean;
  stopped?: CaptureStop;
  code?: string | null;
}

export interface CaptureUploader {
  getState(): CaptureState;
  subscribe(listener: (state: CaptureState) => void): () => void;
  /** Create the server capture; `totalMs` pre-plans the slices (stub tests). */
  startCapture(options?: { title?: string; totalMs?: number }): Promise<CaptureState>;
  uploadSlice(seq: number, startMs: number, durationMs: number, filePath: string): Promise<SliceResult>;
  /** Re-send every retryable slice in seq order; returns the seqs re-sent. */
  retryPending(): Promise<number[]>;
  finishCapture(): Promise<CaptureState>;
  abandonCapture(): Promise<CaptureState>;
}

/** Codes that cannot be improved by sending the slice again. */
const TERMINAL_CODES = new Set([
  "bad_seq",
  "bad_start_ms",
  "missing_audio",
  "chunk_audio_gone",
  "chunk_retry_exhausted",
  "chunk_too_large",
  "timeline_conflict",
  "capture_not_recording",
  "not_found",
  "voice_disabled",
  "voice_not_configured",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stopOf(value: unknown): CaptureStop | null {
  return value === "minutes" || value === "usd" ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "network request failed";
}

function emptyState(): CaptureState {
  return {
    captureId: null,
    status: "idle",
    slices: [],
    chunks: [],
    progress: captureProgress([], () => 0),
    complete: true,
    pending: 0,
    stopped: null,
    segments: [],
    text: "",
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export function createCaptureUploader(deps: CaptureUploadDeps): CaptureUploader {
  const sliceMs = deps.platform.sliceMs && deps.platform.sliceMs > 0 ? deps.platform.sliceMs : 30_000;
  const now = deps.platform.now ?? (() => Date.now());
  const files = new Map<number, string>();
  const listeners = new Set<(state: CaptureState) => void>();
  let state = emptyState();

  const durationOf = (seq: number) => state.slices.find((s) => s.seq === seq)?.durationMs ?? 0;

  /** Publish a snapshot with progress/reachability recomputed from the plan. */
  function publish(patch: Partial<CaptureState>): CaptureState {
    const next = { ...state, ...patch };
    next.progress = captureProgress(next.chunks, durationOf);
    next.complete = captureComplete(next.chunks);
    next.pending = pendingSlices(next.chunks, CAPTURE_MAX_ATTEMPTS).length;
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  }

  function setChunk(seq: number, patch: Partial<SliceState>): void {
    const index = state.chunks.findIndex((c) => c.seq === seq);
    const current: SliceState = index >= 0 ? state.chunks[index] : { seq, status: "pending", attempts: 0 };
    const merged: SliceState = { ...current, ...patch, seq };
    const chunks = index >= 0 ? state.chunks.map((c, i) => (i === index ? merged : c)) : [...state.chunks, merged];
    chunks.sort((a, b) => a.seq - b.seq);
    publish({ chunks });
  }

  function upsertSlice(slice: CaptureSlice): void {
    const index = state.slices.findIndex((s) => s.seq === slice.seq);
    const slices = index >= 0 ? state.slices.map((s, i) => (i === index ? { ...s, ...slice } : s)) : [...state.slices, slice];
    slices.sort((a, b) => a.seq - b.seq);
    const chunks = state.chunks.some((c) => c.seq === slice.seq)
      ? state.chunks
      : [...state.chunks, { seq: slice.seq, status: "pending" as const, attempts: 0 }].sort((a, b) => a.seq - b.seq);
    publish({ slices, chunks });
  }

  /** Interpret one chunk response through the shared retry ceiling. */
  function applyChunkResponse(seq: number, res: CaptureUploadResponse, localAttempts: number): SliceResult {
    const body = asRecord(res.body);
    const chunk = asRecord(body.chunk);
    const serverAttempts = Number(chunk.attempts);
    const attempts = Math.max(localAttempts, Number.isFinite(serverAttempts) ? serverAttempts : 0);
    const stopped = stopOf(body.stopped);
    const serverStatus = String(chunk.status ?? "");
    const duplicate = body.duplicate === true;
    const succeeded = res.status >= 200 && res.status < 300 && (serverStatus === "done" || duplicate);

    if (succeeded) {
      setChunk(seq, { status: "done", attempts, retryable: undefined });
      // A success can carry the gate's closure: that slice is transcribed, but
      // nothing more will be sent.
      publish({ ...(stopped ? { stopped } : {}), error: null });
      return { seq, ok: true, ...(stopped ? { stopped } : {}), duplicate };
    }

    if (res.status === 202 || stopped) {
      // Buffered, not transcribed: the audio is the user's and the server kept
      // it, but re-sending while the gate is closed only wastes the network.
      setChunk(seq, { status: "failed", attempts, retryable: false });
      if (stopped) publish({ stopped });
      return { seq, ok: false, stopped: stopped ?? undefined, code: String(body.code ?? "budget_stopped") };
    }

    const code = String(body.code ?? "");
    if (res.status === 409 && code === "chunk_busy") {
      // Another request owns this slice; wait for it rather than piling on.
      setChunk(seq, { status: "transcribing", attempts });
      return { seq, ok: false, code };
    }

    const explicitRetryable = typeof body.retryable === "boolean" ? body.retryable : null;
    const retryable =
      explicitRetryable ?? (!TERMINAL_CODES.has(code) && attempts < CAPTURE_MAX_ATTEMPTS);
    setChunk(seq, {
      status: "failed",
      attempts,
      retryable: retryable && attempts < CAPTURE_MAX_ATTEMPTS ? undefined : false,
    });
    publish({ error: String(body.error ?? code ?? `upload failed (${res.status})`) });
    return { seq, ok: false, code };
  }

  async function startCapture(options?: { title?: string; totalMs?: number }): Promise<CaptureState> {
    files.clear();
    state = emptyState();
    const title = options?.title ?? "";
    let res: CaptureUploadResponse;
    try {
      res = await deps.upload({ op: "create", title });
    } catch (err) {
      publish({ status: "error", error: errorText(err) });
      return state;
    }
    const body = asRecord(res.body);
    const capture = asRecord(body.capture);
    const captureId = typeof capture.id === "string" ? capture.id : "";
    if (res.status < 200 || res.status >= 300 || !captureId) {
      publish({
        status: "error",
        error: String(body.error ?? body.code ?? `capture failed (${res.status})`),
      });
      return state;
    }
    const totalMs = Number(options?.totalMs);
    const slices = Number.isFinite(totalMs) && totalMs > 0 ? planSlices(totalMs, sliceMs) : [];
    publish({
      captureId,
      status: "recording",
      startedAt: now(),
      slices,
      chunks: slices.map((s) => ({ seq: s.seq, status: "pending", attempts: 0 })),
      stopped: null,
      error: null,
      segments: [],
      text: "",
    });
    return state;
  }

  async function uploadSlice(
    seq: number,
    startMs: number,
    durationMs: number,
    filePath: string,
  ): Promise<SliceResult> {
    if (!state.captureId) throw new Error("capture not started");
    if (state.stopped) return { seq, ok: false, skipped: true, stopped: state.stopped };
    upsertSlice({ seq, startMs, durationMs });
    files.set(seq, filePath);
    const previous = state.chunks.find((c) => c.seq === seq);
    const attempts = (previous?.attempts ?? 0) + 1;
    setChunk(seq, { status: "transcribing", attempts, retryable: undefined });
    let res: CaptureUploadResponse;
    try {
      res = await deps.upload({
        op: "chunk",
        captureId: state.captureId,
        seq,
        startMs,
        durationMs,
        filePath,
      });
    } catch (err) {
      setChunk(seq, {
        status: "failed",
        attempts,
        retryable: attempts < CAPTURE_MAX_ATTEMPTS ? undefined : false,
      });
      publish({ error: errorText(err) });
      return { seq, ok: false, code: "network_error" };
    }
    return applyChunkResponse(seq, res, attempts);
  }

  async function retryPending(): Promise<number[]> {
    if (state.stopped) return [];
    // The queue itself is the shared module's decision: only send what it
    // still considers retryable, in seq order.
    const queued = pendingSlices(state.chunks, CAPTURE_MAX_ATTEMPTS);
    const sent: number[] = [];
    for (const seq of queued) {
      const slice = state.slices.find((s) => s.seq === seq);
      const filePath = files.get(seq);
      if (!slice || !filePath) continue;
      sent.push(seq);
      await uploadSlice(seq, slice.startMs, slice.durationMs, filePath);
      if (state.stopped) break;
    }
    return sent;
  }

  async function finishCapture(): Promise<CaptureState> {
    if (!state.captureId) throw new Error("capture not started");
    let res: CaptureUploadResponse;
    try {
      res = await deps.upload({ op: "finish", captureId: state.captureId });
    } catch (err) {
      publish({ status: "error", error: errorText(err) });
      return state;
    }
    const body = asRecord(res.body);
    if (res.status < 200 || res.status >= 300) {
      publish({ status: "error", error: String(body.error ?? body.code ?? `finish failed (${res.status})`) });
      return state;
    }
    const raw = Array.isArray(body.segments) ? body.segments : [];
    const segments = raw
      .map((s) => asRecord(s))
      .map((s) => ({ startMs: Number(s.startMs) || 0, text: String(s.text ?? "").trim() }))
      .filter((s) => s.text)
      .sort((a, b) => a.startMs - b.startMs);
    return publish({
      status: "finished",
      finishedAt: now(),
      segments,
      text: exportCaptureText(segments),
      error: null,
    });
  }

  async function abandonCapture(): Promise<CaptureState> {
    if (!state.captureId) return state;
    try {
      await deps.upload({ op: "abandon", captureId: state.captureId });
    } catch (err) {
      publish({ status: "error", error: errorText(err) });
      return state;
    }
    files.clear();
    return publish({ status: "abandoned", slices: [], chunks: [], segments: [], text: "", stopped: null });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startCapture,
    uploadSlice,
    retryPending,
    finishCapture,
    abandonCapture,
  };
}
