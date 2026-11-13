// voice-recorder — the cross-client recording state machine (voice-lane,
// add-voice-input-mobile D1).
//
// Three clients record three different ways: the browser streams Blob chunks
// out of `MediaRecorder`, the mini-program gets a temp file path out of
// `RecorderManager.onStop`, the app gets a file handle out of `expo-audio`.
// The *behaviour* around them is identical and that behaviour is what the spec
// pins: five states, no auto-send, cancel leaves nothing behind, an empty take
// never leaves the device, and no second take while one is transcribing.
//
// So the transitions live here — once — and each client supplies only an
// adapter. The artifact type is generic on purpose: this module must stay
// DOM-free (packages/core has no DOM at the transport layer, and the
// mini-program has neither Blob nor fetch).
//
// Invariants this module enforces, each covered by
// scripts/test-voice-recorder-state.mjs:
//   • cancel() bumps a generation; any artifact that arrives afterwards is
//     dropped, so a cancel can never produce an upload.
//   • an artifact with `empty: true` (or a null artifact) returns to idle
//     without calling upload — a mis-tapped mic costs no request.
//   • start() while transcribing is a no-op, not an error.
//   • every illegal transition is a silent no-op: never a throw, never a
//     side effect.

export type VoicePhase = "idle" | "requesting" | "recording" | "transcribing" | "error";

export type VoiceErrorCode =
  | "permission_denied"
  | "local_rejected"
  | "upload_failed"
  | "interrupted"
  | "recorder_failed";

export interface VoiceFailure {
  code: VoiceErrorCode;
  message: string;
  /** Credential-shaped failures carry the panel whose connect card fixes them. */
  connect?: { panel: string } | null;
}

/** What a recorder adapter hands back. `null` = nothing was captured. */
export interface RecordedTake<TArtifact> {
  artifact: TArtifact;
  fileName: string;
  durationMs: number;
  /** Adapter-declared emptiness (zero bytes / zero frames). Treated as no-op. */
  empty?: boolean;
}

export interface RecorderAdapter<TArtifact> {
  /** False when the platform cannot record at all (no API). */
  isSupported(): boolean;
  /** Resolve false when the user (or the platform) refuses. Must not prompt twice. */
  requestPermission(): Promise<boolean>;
  /** Begin capturing. Rejects only for genuine start failures. */
  start(): Promise<void>;
  /** Finish capturing and yield the take, or null when there is nothing. */
  stop(): Promise<RecordedTake<TArtifact> | null>;
  /** Discard the current take. Must resolve even if nothing was recording. */
  cancel(): Promise<void>;
}

export interface VoiceRecorderOptions<TArtifact> {
  adapter: RecorderAdapter<TArtifact>;
  /** Forward the take to /api/voice/transcriptions (or the client's equivalent). */
  upload: (take: RecordedTake<TArtifact>) => Promise<{ text: string }>;
  /** Offers the transcript to the composer. Never called with an empty string. */
  insert: (text: string) => void;
  /**
   * Client-side preflight: refuse locally what would certainly fail upstream
   * (over the upload limit, unsupported container). Returning a reason means
   * "do not upload".
   */
  preflight?: (take: RecordedTake<TArtifact>) => { ok: true } | { ok: false; reason: string };
  /** Automatic stop for over-long takes; 0 disables. */
  autoStopMs?: number;
  /** Messages for the three generic failures (the client owns the wording/i18n). */
  messages?: Partial<Record<VoiceErrorCode, string>>;
  onPhase?: (phase: VoicePhase, failure: VoiceFailure | null) => void;
}

const DEFAULT_MESSAGES: Record<VoiceErrorCode, string> = {
  permission_denied: "Microphone access was denied",
  local_rejected: "This recording cannot be sent",
  upload_failed: "Transcription failed",
  interrupted: "Transcription was interrupted",
  recorder_failed: "Recording could not start",
};

/**
 * The platform's upload ceiling for one audio file (voice-lane answers 413
 * above it). Clients check BEFORE uploading so a doomed request never leaves
 * the device — a wasted round trip on a slow link is the failure this prevents.
 */
export const VOICE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Rough size of a take, from its duration and the recorder's bit rate. */
export function estimateVoiceBytes(durationMs: number, bitsPerSecond: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return 0;
  return Math.ceil((durationMs / 1000) * (bitsPerSecond / 8));
}

/** True when a take of this length still fits under the upload ceiling. */
export function voiceFitsUpload(
  durationMs: number,
  bitsPerSecond: number,
  maxBytes = VOICE_MAX_UPLOAD_BYTES,
): boolean {
  return estimateVoiceBytes(durationMs, bitsPerSecond) <= maxBytes;
}

/**
 * The insertion rule every client shares (voice-lane): trim the transcript,
 * treat a blank one as a no-op, otherwise append it to what is already in the
 * input separated by a single space. Returns null when nothing should be
 * inserted — the caller leaves the input untouched and keeps the draft.
 *
 * Lives here (not in a client) because web, the mini-program and the app must
 * append identically; a per-client copy is how "one client joins without a
 * space" bugs happen.
 */
export function composeTranscript(base: string, text: string): string | null {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) return null;
  const trimmed = (base ?? "").trimEnd();
  return trimmed ? `${trimmed} ${clean}` : clean;
}

export class VoiceRecorder<TArtifact = unknown> {
  private readonly _opts: VoiceRecorderOptions<TArtifact>;
  private _phase: VoicePhase = "idle";
  private _failure: VoiceFailure | null = null;
  private _generation = 0;
  private _autoStop: ReturnType<typeof setTimeout> | null = null;
  private readonly _listeners = new Set<(phase: VoicePhase, failure: VoiceFailure | null) => void>();

  constructor(opts: VoiceRecorderOptions<TArtifact>) {
    this._opts = opts;
  }

  phase(): VoicePhase {
    return this._phase;
  }

  failure(): VoiceFailure | null {
    return this._failure;
  }

  /** True when the platform + adapter can record at all (mic entry renders). */
  canRecord(): boolean {
    try {
      return this._opts.adapter.isSupported();
    } catch {
      return false;
    }
  }

  subscribe(listener: (phase: VoicePhase, failure: VoiceFailure | null) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _emit(): void {
    this._opts.onPhase?.(this._phase, this._failure);
    for (const listener of this._listeners) listener(this._phase, this._failure);
  }

  private _to(phase: VoicePhase, failure: VoiceFailure | null = null): void {
    this._phase = phase;
    this._failure = failure;
    this._emit();
  }

  private _fail(code: VoiceErrorCode, message?: string, connect?: { panel: string } | null): void {
    this._clearAutoStop();
    this._to("error", {
      code,
      message: message ?? this._opts.messages?.[code] ?? DEFAULT_MESSAGES[code],
      connect: connect ?? null,
    });
  }

  private _clearAutoStop(): void {
    if (this._autoStop !== null) {
      clearTimeout(this._autoStop);
      this._autoStop = null;
    }
  }

  /**
   * Begin a take. A no-op while one is in flight (requesting/recording) and
   * while transcribing — the spec forbids starting a second take during
   * transcription rather than queueing it.
   */
  async start(): Promise<void> {
    if (this._phase === "requesting" || this._phase === "recording" || this._phase === "transcribing") return;
    if (!this.canRecord()) {
      this._fail("recorder_failed");
      return;
    }
    const generation = ++this._generation;
    this._to("requesting");

    let granted = false;
    try {
      granted = await this._opts.adapter.requestPermission();
    } catch {
      granted = false;
    }
    // A cancel (or a fresh start) while the permission dialog was up wins.
    if (generation !== this._generation) return;
    if (!granted) {
      this._fail("permission_denied");
      return;
    }

    try {
      await this._opts.adapter.start();
    } catch {
      if (generation !== this._generation) return;
      this._fail("recorder_failed");
      return;
    }
    if (generation !== this._generation) {
      // Cancelled between permission and start: undo the capture we just began.
      void this._opts.adapter.cancel().catch(() => {});
      return;
    }

    this._to("recording");
    const autoStopMs = this._opts.autoStopMs ?? 0;
    if (autoStopMs > 0) {
      this._autoStop = setTimeout(() => {
        this._autoStop = null;
        void this.stop();
      }, autoStopMs);
    }
  }

  /** Stop and transcribe. A no-op unless currently recording. */
  async stop(): Promise<void> {
    if (this._phase !== "recording") return;
    this._clearAutoStop();
    const generation = this._generation;
    // Flip before awaiting the adapter: from the user's point of view the take
    // is over the moment they stop, and this transition is also what makes a
    // second concurrent stop() a no-op (otherwise two stops both pass the
    // guard above and upload the same take twice).
    this._to("transcribing");

    let take: RecordedTake<TArtifact> | null = null;
    try {
      take = await this._opts.adapter.stop();
    } catch {
      if (generation !== this._generation) return;
      this._fail("recorder_failed");
      return;
    }
    // Dropped by a cancel while the adapter was finishing.
    if (generation !== this._generation) return;

    if (!take || take.empty) {
      this._to("idle");
      return;
    }

    if (this._opts.preflight) {
      let verdict: { ok: true } | { ok: false; reason: string };
      try {
        verdict = this._opts.preflight(take);
      } catch {
        verdict = { ok: false, reason: this._opts.messages?.local_rejected ?? DEFAULT_MESSAGES.local_rejected };
      }
      if (!verdict.ok) {
        this._fail("local_rejected", verdict.reason);
        return;
      }
    }

    try {
      const { text } = await this._opts.upload(take);
      if (generation !== this._generation) return;
      const clean = typeof text === "string" ? text.trim() : "";
      // Whitespace-only transcripts insert nothing (web baseline: trim → no-op).
      if (clean) this._opts.insert(clean);
      this._to("idle");
    } catch (e) {
      if (generation !== this._generation) return;
      const carried = (e ?? {}) as { message?: string; connect?: { panel: string } | null };
      this._fail("upload_failed", carried.message, carried.connect ?? null);
    }
  }

  /** Abandon the take: no upload, no insertion, no matter how late the artifact lands. */
  async cancel(): Promise<void> {
    if (this._phase !== "recording" && this._phase !== "requesting" && this._phase !== "transcribing") return;
    this._clearAutoStop();
    this._generation += 1; // invalidates any in-flight stop()/upload()
    this._to("idle");
    try {
      await this._opts.adapter.cancel();
    } catch {
      // Releasing the microphone is best-effort; the take is already dropped.
    }
  }

  /**
   * The page went away (backgrounded, reloaded, process reclaimed) while a
   * transcript was in flight. There is nothing to resume — say so instead of
   * leaving the control stuck on "transcribing".
   */
  markInterrupted(): void {
    if (this._phase !== "transcribing") return;
    this._generation += 1;
    this._fail("interrupted");
  }

  /** Reset an error back to idle (the user dismissed it). */
  dismissError(): void {
    if (this._phase !== "error") return;
    this._to("idle");
  }
}
