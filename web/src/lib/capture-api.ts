// web/src/lib/capture-api.ts — the browser side of the long-recording capture
// lane (openspec: add-voice-capture-lane, 5.1–5.3).
//
// One capture is a series of slices; each slice upload IS its transcription
// request (there is no batch endpoint and no queue). That is why this client
// uploads slice by slice and why a failed slice is a ROW state, not an
// exception: the UI must keep rendering the other 19 slices.
//
// Two refusals are deliberately not thrown:
//   • a lost-response replay answers `duplicate: true` — that is a SUCCESS
//     (the slice is already transcribed and must not be uploaded again);
//   • a per-slice transcription failure answers with the slice's own state plus
//     `retryable` — the caller renders it and offers a retry.
// Everything else (budget/state/transport refusals) throws CaptureRequestError
// carrying the server CODE, so the UI maps it to localized guidance instead of
// printing an English server message at a Chinese user.
//
// Plain fetch + FormData on purpose: the shared @platform/core transport models
// JSON only, and this lane needs multipart uploads and Blob bodies.

export type CaptureStatus = "recording" | "finished" | "expired" | "abandoned";
export type ChunkStatus = "pending" | "transcribing" | "done" | "failed";
export type BudgetCeiling = "minutes" | "usd";

export interface VoiceCapture {
  id: string;
  title: string;
  status: CaptureStatus;
  createdAt: number;
  expiresAt: number;
  finishedAt: number | null;
  budget: { minutes: number; usd: number };
  used: { minutes: number; usd: number };
  mergedText: string | null;
  originalText: string | null;
  correctedAt: number | null;
  roomId: string | null;
  retainAudioMs: number;
}

export interface VoiceCaptureChunk {
  seq: number;
  startMs: number;
  durationMs: number | null;
  status: ChunkStatus;
  text: string;
  attempts: number;
  errorCode: string | null;
  /** The audio was deleted after transcription unless the capture retains it. */
  hasAudio: boolean;
  bytes: number;
  mime: string | null;
}

export interface CaptureBudgetReport {
  minutes: number;
  minutesLimit: number;
  usd: number;
  usdLimit: number;
  resetsAt: number | null;
}

export interface CaptureSegment {
  seq: number;
  startMs: number;
  text: string;
}

export interface CaptureVoiceStatus {
  available: boolean;
  reason: "disabled" | "no_key" | null;
  keySource: "user" | "deployment" | null;
  config: { enabled: boolean; asrModel: string; ttsModel: string; ttsVoice: string; ttsFormat: string };
}

/** One chunk upload's outcome — never an exception for a slice-level refusal. */
export interface ChunkUploadOutcome {
  /** True when the slice landed (or was already transcribed: `duplicate`). */
  ok: boolean;
  /** Refusal code when `ok` is false; null on success. */
  code: string | null;
  chunk: VoiceCaptureChunk | null;
  duplicate: boolean;
  /** Which budget ceiling stopped transcription on this call, if any. */
  stopped: BudgetCeiling | null;
  budget: CaptureBudgetReport | null;
  /** Server's own "may this slice be retried again" verdict, when present. */
  retryable: boolean | undefined;
  detail: Record<string, unknown> | undefined;
}

/** The refusal shape every capture endpoint uses. */
export class CaptureRequestError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown> | undefined;
  constructor(code: string, status: number, detail?: Record<string, unknown>) {
    super(code);
    this.name = "CaptureRequestError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** `duplicate: true` means the slice is already transcribed — a success, never
 *  a second upload and never a second charge. */
export function isDuplicateSuccess(outcome: ChunkUploadOutcome): boolean {
  return outcome.ok && outcome.duplicate;
}

interface ErrorBody {
  code?: unknown;
  detail?: unknown;
}

async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  const body = await res.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

function refusal(res: Response, body: Record<string, unknown> | null): CaptureRequestError {
  const e = body as ErrorBody | null;
  const code = typeof e?.code === "string" ? e.code : `http_${res.status}`;
  const detail = e?.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : undefined;
  return new CaptureRequestError(code, res.status, detail);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    // Transport failure (offline, DNS, aborted): the call never reached the
    // server, so the UI must not report a server refusal code.
    throw new CaptureRequestError("network", 0);
  }
  const body = await readBody(res);
  if (!res.ok) throw refusal(res, body);
  return body as T;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

/** GET /api/voice/status — the same read the composer lane uses. */
export function fetchCaptureVoiceStatus(): Promise<CaptureVoiceStatus> {
  return requestJson<CaptureVoiceStatus>("/api/voice/status");
}

/** GET /api/voice/captures — owner-scoped, newest first. */
export async function listCaptures(): Promise<VoiceCapture[]> {
  const out = await requestJson<{ captures?: VoiceCapture[] }>("/api/voice/captures");
  return Array.isArray(out.captures) ? out.captures : [];
}

export function getCapture(id: string): Promise<{ capture: VoiceCapture; chunks: VoiceCaptureChunk[] }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}`);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export interface CreateCaptureOptions {
  title?: string;
  ttlMs?: number;
  minutesBudget?: number;
  usdBudget?: number;
  retainAudioMs?: number;
  /** Declares WHAT this stream is, never WHO the speaker is (openspec:
   *  meeting-capture-client-wiring, D1). `"session"` = this device records one
   *  person and the server attributes it to the authenticated subject; the
   *  client must not send a member id — that is the server's to derive. */
  speakerMode?: SpeakerMode;
  /** The meeting this stream belongs to. With `speakerMode: "session"` the
   *  meeting read face can say which participant owns which capture. */
  meetingId?: string;
}

/** POST /api/voice/captures — 503 `voice_disabled` / `voice_not_configured`
 *  when the lane is off, exactly like the composer lane. */
export async function createCapture(options: CreateCaptureOptions = {}): Promise<VoiceCapture> {
  const out = await requestJson<{ capture: VoiceCapture }>("/api/voice/captures", jsonInit(options));
  return out.capture;
}

/**
 * POST /api/zhiyu/meetings/:id/capture — record which participant owns this
 * stream (openspec: meeting-capture-client-wiring, D2).
 *
 * Idempotent on the server (a second bind overwrites the same participant's
 * captureId), and it refuses `409 not_joined` when this caller never joined the
 * meeting — a capture must not be attributed to a seat with no evidence of
 * presence. The caller keeps recording on failure: an unbound stream is
 * dispatched to nobody, which is the safe direction (never the wrong person).
 */
export function bindMeetingCapture(
  meetingId: string,
  captureId: string,
): Promise<{ participant: { memberRef: string; captureId: string | null; state: string } }> {
  return requestJson(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/capture`, jsonInit({ captureId }));
}

/** POST /finish — merges the finished slices into the readable text. */
export function finishCapture(
  id: string,
): Promise<{ capture: VoiceCapture; segments: CaptureSegment[]; already: boolean }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/finish`, jsonInit({}));
}

/** POST /correct — allowed ONCE; the machine's merge stays readable as
 *  `originalText` (a correction is a second fact, not an overwrite). */
export async function correctCapture(id: string, text: string): Promise<VoiceCapture> {
  const out = await requestJson<{ capture: VoiceCapture }>(
    `/api/voice/captures/${encodeURIComponent(id)}/correct`,
    jsonInit({ text }),
  );
  return out.capture;
}

/** POST /abandon — deletes the buffered audio AND the transcribed text. */
export function abandonCapture(id: string): Promise<{ ok: true }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/abandon`, jsonInit({}));
}

/** POST /room — one explicit confirmation (`confirm: true`) because this is the
 *  step that publishes a private recording into a room. */
export function sendCaptureToRoom(
  id: string,
  sessionId: string,
): Promise<{ ok: true; sessionId: string; alreadyInRoom?: boolean }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/room`, jsonInit({ sessionId, confirm: true }));
}

/**
 * POST /zhiyu-room — the same confirmation, into a 智语 room (`zy_…`).
 *
 * The difference is not transport. A 智语 room routes every message to an agent,
 * so the server splits the recording per speaker and sends each stretch with its
 * own attribution; the response says how many messages that made and, per
 * message, which agent it reached — or that it is waiting for a human to say who
 * spoke (`basis: "needs_confirmation"`).
 */
export function sendCaptureToVoiceRoom(
  id: string,
  roomId: string,
): Promise<{
  ok: true;
  roomId: string;
  alreadyInRoom?: boolean;
  messages?: number;
  delivered?: Array<{ seq: number; senderRef: string; decision?: { basis: string | null } | null }>;
}> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/zhiyu-room`, jsonInit({ roomId, confirm: true }));
}

// ── chunk upload ────────────────────────────────────────────────────────────

/** File name drives the extension the server sniffs the container from.
 *  Exported so the contract test can execute it: a slice uploaded under a
 *  `.webm` name is refused by the lane no matter what the bytes are
 *  (openspec: fix-voice-transcription-container). */
export function sliceFileName(blob: Blob): string {
  const type = (blob.type || "audio/webm").split(";")[0] ?? "audio/webm";
  const ext = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : type === "audio/wav" ? "wav" : "webm";
  return `capture-slice.${ext}`;
}

/**
 * POST /:id/chunks — multipart, one slice per call.
 *
 * `audio` is null for a RETRY: the server kept the failed slice's audio, so a
 * retry is one request with no re-upload. A refusal is returned as data
 * (`ok: false`, code + slice state) because a failed slice is a rendered row,
 * not an exception.
 */
export async function uploadCaptureChunk(
  captureId: string,
  slice: { seq: number; startMs: number; durationMs: number | null },
  audio: Blob | null,
): Promise<ChunkUploadOutcome> {
  const form = new FormData();
  form.append("seq", String(slice.seq));
  form.append("start_ms", String(slice.startMs));
  if (slice.durationMs !== null && Number.isFinite(slice.durationMs)) {
    form.append("duration_ms", String(Math.max(0, Math.round(slice.durationMs))));
  }
  if (audio) form.append("file", audio, sliceFileName(audio));

  let res: Response;
  try {
    res = await fetch(`/api/voice/captures/${encodeURIComponent(captureId)}/chunks`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
  } catch {
    // The bytes never reached the server. The slice is lost unless a retry
    // re-uploads it, so the caller must surface this as a failed row.
    throw new CaptureRequestError("network", 0);
  }

  const body = await readBody(res);
  const chunk = body && typeof body.chunk === "object" ? (body.chunk as VoiceCaptureChunk) : null;
  const duplicate = body?.duplicate === true;
  const stopped = body?.stopped === "minutes" || body?.stopped === "usd" ? (body.stopped as BudgetCeiling) : null;
  const budget = body && typeof body.budget === "object" ? (body.budget as CaptureBudgetReport) : null;
  const retryable = typeof body?.retryable === "boolean" ? (body.retryable as boolean) : undefined;
  const detail =
    body?.detail && typeof body.detail === "object" ? (body.detail as Record<string, unknown>) : undefined;

  // 202 is a success with `stopped`: the slice was STORED but not transcribed.
  // `duplicate: true` is a success on a replay.
  if (!res.ok && !duplicate) {
    const err = refusal(res, body);
    return {
      ok: false,
      code: err.code,
      chunk,
      duplicate,
      stopped,
      budget,
      retryable,
      detail,
    };
  }

  return { ok: true, code: null, chunk, duplicate, stopped, budget, retryable, detail };
}

// ── speaker attribution (openspec: add-speaker-attribution) ──────────────────
//
// The attribution face of one capture: which cluster said which slice, how sure
// we are, and the trail of humans renaming those clusters.
//
// `separation` is a FOUR-value answer, not a boolean. `separated` is true only
// for FULL separation, and a surface that renders `partial` as `full` would
// claim identities it does not have — that is the bug this lane exists to
// prevent, so both fields are typed here and neither is normalized away.

export type SpeakerMode = "shared" | "session";
export type AttributionCertainty = "session" | "bound" | "anonymous";
/** `partial` is its own state: some slices separated, the rest fell back. */
export type SeparationState = "none" | "partial" | "full" | "not_needed";

/** A separation result that disagreed with the slice's session identity. The
 *  session identity wins, and the disagreement is recorded — never silent. */
export interface AttributionConflict {
  clusters: string[];
  note: string;
}

export interface CaptureAttribution {
  cluster: string;
  startMs: number;
  endMs: number;
  member: string | null;
  certainty: AttributionCertainty;
  /** User-facing reason from the server (already localized there). */
  basis: string;
  conflict: AttributionConflict | null;
}

export interface CaptureBinding {
  cluster: string;
  member: string;
  boundBy: string;
  boundAt: number;
}

export interface CaptureBindingEvent {
  cluster: string;
  op: "bind" | "rebind" | "unbind";
  from: string | null;
  to: string | null;
  actor: string;
  at: number;
}

export interface CaptureAttributionSummary {
  total: number;
  session: number;
  bound: number;
  anonymous: number;
  separation: SeparationState;
  separated: boolean;
  dispatchable: number;
  needsConfirmation: number;
  conflicts: number;
}

export interface CaptureAttributions {
  captureId: string;
  speakerMode: SpeakerMode;
  separated: boolean;
  attributions: CaptureAttribution[];
  bindings: CaptureBinding[];
  events: CaptureBindingEvent[];
  summary: CaptureAttributionSummary;
  /** Answers adopted from the todo surface on this read — a receipt, not work. */
  adopted: { cluster: string; member: string }[];
}

/** GET /api/voice/captures/:id/attributions — owner-scoped. Answering a
 *  `speaker-attribution` card in the todo surface is adopted on the next read. */
export function fetchCaptureAttributions(id: string): Promise<CaptureAttributions> {
  return requestJson<CaptureAttributions>(`/api/voice/captures/${encodeURIComponent(id)}/attributions`);
}

/**
 * POST /bind — name one anonymous cluster.
 *
 * 409 `member_not_present` (with `detail.member`) and 400 `bad_binding` throw a
 * CaptureRequestError, so the panel can say what the code means in Chinese
 * instead of echoing the server's English message at the user.
 */
export function bindCaptureCluster(
  id: string,
  cluster: string,
  member: string,
): Promise<{ ok: true; op: "bind" | "rebind"; previous: string | null; attributions: CaptureAttribution[] }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/bind`, jsonInit({ cluster, member }));
}

/** POST /unbind — take the name back. Reversible and audited (`events`). */
export function unbindCaptureCluster(
  id: string,
  cluster: string,
): Promise<{ ok: true; previous: string | null; attributions: CaptureAttribution[] }> {
  return requestJson(`/api/voice/captures/${encodeURIComponent(id)}/unbind`, jsonInit({ cluster }));
}
