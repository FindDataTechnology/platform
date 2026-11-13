// voice-capture-slices — the cross-client slicing + upload plan for a long
// recording (openspec: add-voice-capture-lane, D1/D2, tasks 5.1 / 5.4).
//
// Why this lives in packages/core and not in each client: the spec forbids each
// client writing its own retry ("三端共用同一个「切片 + 补偿重传」实现，不允许每端
// 自己写重传"). A recording that slices differently on the phone than in the
// browser would produce a different transcript for the same meeting — and the
// transcript is the artifact people read afterwards.
//
// DOM-free like voice-recorder.ts: no Blob, no fetch, no timers. Each client
// injects the recorder and the transport; this module decides WHAT to send and
// WHEN to retry, and nothing else.

/** One slice as the server wants it: a seq, where it starts, how long it is. */
export interface CaptureSlice {
  seq: number;
  startMs: number;
  durationMs: number;
}

/**
 * What a client should do with one slice right now.
 *   send      — never uploaded, or uploaded but failed and still retryable
 *   wait      — in flight
 *   done      — transcribed; never send again
 *   give-up   — failed and out of attempts
 */
export type SliceAction = "send" | "wait" | "done" | "give-up";

export interface SliceState {
  seq: number;
  status: "pending" | "transcribing" | "done" | "failed";
  attempts: number;
  retryable?: boolean;
}

/** Server-enforced ceiling (voice-capture.js CAPTURE_DEFAULTS.maxAttempts). */
export const CAPTURE_MAX_ATTEMPTS = 2;

/**
 * Plan the slices for a recording of `totalMs`.
 *
 * The slices are contiguous and cover the whole recording: no gap (audio that
 * would silently vanish from the transcript) and no overlap (the same words
 * twice). A final short remainder becomes its own smaller slice rather than
 * being padded — padding would upload silence and pay to transcribe it.
 */
export function planSlices(totalMs: number, chunkMs = 30_000): CaptureSlice[] {
  const total = Number.isFinite(totalMs) ? Math.floor(totalMs) : 0;
  const size = Number.isFinite(chunkMs) && chunkMs > 0 ? Math.floor(chunkMs) : 30_000;
  if (total <= 0) return [];
  const out: CaptureSlice[] = [];
  for (let startMs = 0, seq = 0; startMs < total; startMs += size, seq += 1) {
    out.push({ seq, startMs, durationMs: Math.min(size, total - startMs) });
  }
  return out;
}

/** True when the plan tiles [0, totalMs) exactly — the invariant planSlices holds. */
export function slicesCoverTotal(slices: CaptureSlice[], totalMs: number): boolean {
  if (!slices.length) return totalMs <= 0;
  let cursor = 0;
  for (const s of slices) {
    if (s.startMs !== cursor) return false;
    if (s.durationMs <= 0) return false;
    cursor += s.durationMs;
  }
  return cursor === Math.floor(totalMs);
}

/**
 * Decide one slice's next action.
 *
 * The retry ceiling is the server's, mirrored here so a client stops asking
 * before it earns a 409. `retryable` from the last response wins when present:
 * the server knows whether that slice still has audio to retry with.
 */
export function sliceAction(state: SliceState, maxAttempts = CAPTURE_MAX_ATTEMPTS): SliceAction {
  if (state.status === "done") return "done";
  if (state.status === "transcribing") return "wait";
  if (state.retryable === false) return "give-up";
  if (state.attempts >= maxAttempts) return "give-up";
  return "send";
}

/** What the client needs to know to draw a progress list (5.1). */
export interface CaptureProgress {
  total: number;
  done: number;
  failed: number;
  inFlight: number;
  waiting: number;
  /** 0..1, by slices settled either way. A failure is settled work, not zero. */
  fraction: number;
  /** Minutes of audio whose text we actually have. */
  transcribedMinutes: number;
}

export function captureProgress(chunks: SliceState[], durationOf: (seq: number) => number): CaptureProgress {
  const total = chunks.length;
  const done = chunks.filter((c) => c.status === "done").length;
  const failed = chunks.filter((c) => c.status === "failed").length;
  const inFlight = chunks.filter((c) => c.status === "transcribing").length;
  const waiting = total - done - failed - inFlight;
  const settled = done + failed;
  const transcribedMs = chunks
    .filter((c) => c.status === "done")
    .reduce((sum, c) => sum + Math.max(0, durationOf(c.seq) || 0), 0);
  return {
    total,
    done,
    failed,
    inFlight,
    waiting,
    fraction: total === 0 ? 0 : settled / total,
    transcribedMinutes: transcribedMs / 60_000,
  };
}

/**
 * The retry queue: which slices to re-send when the network comes back, in seq
 * order. Order matters — a client that resumes at random fills the timeline out
 * of order, which is fine, but resuming in order means the reader sees the
 * meeting fill in from the beginning.
 */
export function pendingSlices(chunks: SliceState[], maxAttempts = CAPTURE_MAX_ATTEMPTS): number[] {
  return chunks
    .filter((c) => sliceAction(c, maxAttempts) === "send")
    .map((c) => c.seq)
    .sort((a, b) => a - b);
}

/** True when every slice is settled — the recording can be finished. */
export function captureComplete(chunks: SliceState[]): boolean {
  return chunks.every((c) => c.status === "done" || sliceAction(c) === "give-up");
}

/** mm:ss from a millisecond offset, for the segment list. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * The plain-text export (5.1). Deliberately identical on all three clients:
 * offset, a tab, the text — one line per segment, no headings, so the file
 * pastes into a mail or a doc without carrying our UI's opinions with it.
 */
export function exportCaptureText(segments: { startMs: number; text: string }[]): string {
  return segments
    .map((s) => ({ at: formatOffset(s.startMs), text: String(s.text ?? "").trim() }))
    .filter((s) => s.text)
    .map((s) => `[${s.at}] ${s.text}`)
    .join("\n");
}
