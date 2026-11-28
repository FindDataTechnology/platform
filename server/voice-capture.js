// server/voice-capture.js — long-recording capture: chunked upload, per-chunk
// transcription, timeline merge (openspec: add-voice-capture-lane, 1.1–4.3).
//
// Why a second voice surface at all: the composer lane takes ONE ≤25MB blob and
// answers once. A one-hour meeting is neither (≈28MB at 64kbps, and no partial
// text until the very end). This module keeps the composer lane untouched (the
// spec forbids changing its contract) and adds a capture session that:
//
//   • accepts chunks out of order, keyed by (capture, seq),
//   • transcribes each chunk independently so one upstream failure cannot block
//     the other 19 (no big transaction, no rollback of finished work),
//   • merges by CLIENT-REPORTED start_ms, never by upstream timestamps (the
//     current protocol returns plain text only),
//   • deletes the audio the moment a chunk is transcribed (retain=0 default).
//
// Deliberate non-goals: no queue, no background worker. A chunk transcribes
// inside its own request. That keeps the failure model trivial (each upload is
// its own retry) and matches how the client already uploads slice by slice.
//
// Merge determinism is asserted byte-for-byte in the tests: the same chunk set
// must always produce the same text, because the merged text is later corrected
// by a human and stored as the record of a meeting.

import { randomBytes } from "node:crypto";
import { SPEAKER_UNKNOWN, bindingsMap } from "./speaker-attribution.js";

export const CAPTURE_STATUSES = Object.freeze(["recording", "finished", "expired", "abandoned"]);
export const CHUNK_STATUSES = Object.freeze(["pending", "transcribing", "done", "failed"]);

/** Defaults; the spec pins that these EXIST and are configurable, not values. */
export const CAPTURE_DEFAULTS = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1000,
  minutesBudget: 120,
  usdBudget: 6,
  retainAudioMs: 0,
  maxAttempts: 2,
  chunkMaxBytes: 8 * 1024 * 1024,
});

/** An unpredictable, URL-safe id (the spec forbids guessable capture ids). */
export function newCaptureId() {
  return `cap_${randomBytes(16).toString("base64url")}`;
}

export function ensureVoiceCaptureTables(handle) {
  handle.exec(`CREATE TABLE IF NOT EXISTS voice_captures (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    finished_at INTEGER,
    minutes_budget REAL NOT NULL,
    usd_budget REAL NOT NULL,
    minutes_used REAL NOT NULL DEFAULT 0,
    usd_used REAL NOT NULL DEFAULT 0,
    merged_text TEXT,
    original_text TEXT,
    corrected_at INTEGER,
    room_id TEXT,
    retain_audio_ms INTEGER NOT NULL DEFAULT 0,
    -- Which meeting this stream belongs to (add-meeting-capture D3): NULL means a
    -- standalone capture, i.e. exactly today's behaviour. The meeting entity
    -- itself lives in the gateway's room db — this is a weak reference, and the
    -- only thing the platform needs in order to stamp the room message.
    meeting_id TEXT,
    -- Who was speaking: 'shared' (a room microphone — the honest default, since
    -- assuming otherwise would attribute a whole meeting to one person) or
    -- 'session' (the owner recorded alone on their own device).
    speaker_mode TEXT NOT NULL DEFAULT 'shared'
  )`);
  // Same-table migration for a capture created before this column existed: the
  // table is feature-owned, so it upgrades itself rather than relying on a
  // version bump somewhere else.
  const cols = new Set(handle.prepare("PRAGMA table_info(voice_captures)").all().map((c) => c.name));
  if (!cols.has("speaker_mode")) {
    handle.exec(`ALTER TABLE voice_captures ADD COLUMN speaker_mode TEXT NOT NULL DEFAULT 'shared'`);
  }
  // Same-table migration for meeting capture: NULL = a standalone capture, so
  // existing rows need no backfill and behave byte-identically.
  if (!cols.has("meeting_id")) {
    handle.exec(`ALTER TABLE voice_captures ADD COLUMN meeting_id TEXT`);
  }
  handle.exec(`CREATE INDEX IF NOT EXISTS idx_voice_captures_owner ON voice_captures(owner, created_at)`);
  // UNIQUE(capture_id, seq) is the idempotency anchor at the STORAGE level: a
  // duplicate insert throws, so a second text/charge can never be written even
  // if a future caller forgets to check first.
  handle.exec(`CREATE TABLE IF NOT EXISTS voice_capture_chunks (
    capture_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    audio BLOB,
    bytes INTEGER NOT NULL DEFAULT 0,
    mime TEXT,
    created_at INTEGER NOT NULL,
    transcribed_at INTEGER,
    -- When this slice was reserved for transcription. The sweep uses it to free
    -- a slice whose request died mid-flight: without it a crashed process leaves
    -- the chunk in the transcribing state forever and no retry can ever start.
    transcribing_at INTEGER,
    PRIMARY KEY (capture_id, seq)
  )`);
  // Same-table migration, the `speaker_mode` pattern above: the segment record
  // grows an optional speaker and a normalised end offset (add-speaker-attribution
  // D7). NULL means "unknown" — exactly what today's render path already assumes —
  // so there is nothing to backfill and no migration risk.
  //
  // `segments_json` keeps the lane's normalised segment array verbatim. The merge
  // (3.2) has to align segments by offset and REFUSE a chunk whose segments
  // disagree with its text; without the raw array it could only guess, and
  // collapsing a genuinely two-voice chunk into one name is the failure this
  // whole capability exists to prevent.
  const chunkCols = new Set(handle.prepare("PRAGMA table_info(voice_capture_chunks)").all().map((c) => c.name));
  if (!chunkCols.has("speaker")) handle.exec(`ALTER TABLE voice_capture_chunks ADD COLUMN speaker TEXT`);
  if (!chunkCols.has("end_ms")) handle.exec(`ALTER TABLE voice_capture_chunks ADD COLUMN end_ms INTEGER`);
  if (!chunkCols.has("segments_json")) handle.exec(`ALTER TABLE voice_capture_chunks ADD COLUMN segments_json TEXT`);
}

export function deserializeCapture(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at ?? null,
    budget: { minutes: row.minutes_budget, usd: row.usd_budget },
    used: { minutes: row.minutes_used, usd: row.usd_used },
    mergedText: row.merged_text ?? null,
    originalText: row.original_text ?? null,
    correctedAt: row.corrected_at ?? null,
    roomId: row.room_id ?? null,
    retainAudioMs: row.retain_audio_ms,
    speakerMode: row.speaker_mode ?? "shared",
    meetingId: row.meeting_id ?? null,
  };
}

/** `segments_json` is our own write, but a hand-edited row must not throw a read. */
export function parseSegmentsJson(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

export function deserializeChunk(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    startMs: row.start_ms,
    durationMs: row.duration_ms ?? null,
    status: row.status,
    text: row.text,
    attempts: row.attempts,
    errorCode: row.error_code ?? null,
    // Who spoke this slice (add-speaker-attribution 3.1/D7). NULL means unknown:
    // the lane returned no label, or the slice mixes voices — never a sentinel.
    // `endMs` is absolute in the capture timeline; `segments` is whatever detail
    // the lane gave, kept so the merge can align and refuse rather than guess.
    speaker: row.speaker ?? null,
    endMs: row.end_ms ?? null,
    segments: parseSegmentsJson(row.segments_json),
    // The AUDIO is never exposed through the read face — only its existence,
    // so a client can tell "still retained" from "already deleted".
    hasAudio: row.audio != null,
    bytes: row.bytes,
    mime: row.mime ?? null,
  };
}

export function createCapture(handle, { owner, cellId, title = "", speakerMode = "shared", meetingId = null, now = Date.now(), options = {} }) {
  const opts = { ...CAPTURE_DEFAULTS, ...options };
  const id = newCaptureId();
  handle
    .prepare(
      `INSERT INTO voice_captures (id, owner, cell_id, title, status, created_at, expires_at,
        minutes_budget, usd_budget, retain_audio_ms, speaker_mode, meeting_id)
       VALUES (?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      owner,
      cellId,
      title.slice(0, 200),
      now,
      now + opts.ttlMs,
      opts.minutesBudget,
      opts.usdBudget,
      opts.retainAudioMs,
      speakerMode === "session" ? "session" : "shared",
      meetingId ? String(meetingId).slice(0, 64) : null,
    );
  return getCapture(handle, { id, owner, now });
}

/** Owner-scoped read. A not-yours id is null — the route answers one 404. */
export function getCapture(handle, { id, owner, now = Date.now() }) {
  const row = handle.prepare("SELECT * FROM voice_captures WHERE id = ? AND owner = ?").get(id, owner);
  if (!row) return null;
  const capture = deserializeCapture(row);
  // Expiry is a read-time fact, not a scheduled job: an expired capture stops
  // accepting chunks even if no cleaner has run yet.
  if (capture.status === "recording" && capture.expiresAt <= now) capture.status = "expired";
  return capture;
}

export function listCaptures(handle, { owner, now = Date.now(), limit = 50 }) {
  return handle
    .prepare(
      `SELECT * FROM voice_captures
        WHERE owner = ? AND status != 'abandoned'
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(owner, limit)
    .map((row) => {
      const c = deserializeCapture(row);
      if (c.status === "recording" && c.expiresAt <= now) c.status = "expired";
      return c;
    });
}

export function listChunks(handle, { captureId }) {
  return handle
    .prepare("SELECT * FROM voice_capture_chunks WHERE capture_id = ? ORDER BY seq")
    .all(captureId)
    .map(deserializeChunk);
}

/**
 * Validate a chunk's timeline position (3.1): start_ms must be strictly
 * increasing WITH seq. A contradictory pair is refused and the CONFLICTING
 * slice is named, because "your chunk 4 is monotonic" is not actionable.
 */
export function checkTimeline(handle, { captureId, seq, startMs }) {
  const before = handle
    .prepare("SELECT seq, start_ms FROM voice_capture_chunks WHERE capture_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1")
    .get(captureId, seq);
  if (before && startMs <= before.start_ms) {
    return { ok: false, code: "timeline_conflict", detail: { conflictingSeq: before.seq } };
  }
  const after = handle
    .prepare("SELECT seq, start_ms FROM voice_capture_chunks WHERE capture_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1")
    .get(captureId, seq);
  if (after && startMs >= after.start_ms) {
    return { ok: false, code: "timeline_conflict", detail: { conflictingSeq: after.seq } };
  }
  return { ok: true };
}

/** Insert one chunk's audio. Duplicate (capture, seq) is a storage-level error. */
export function insertChunk(handle, { captureId, seq, startMs, durationMs = null, buffer, mime, now = Date.now() }) {
  try {
    handle
      .prepare(
        `INSERT INTO voice_capture_chunks (capture_id, seq, start_ms, duration_ms, status, audio, bytes, mime, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(captureId, seq, startMs, durationMs, buffer ?? null, buffer?.length ?? 0, mime ?? null, now);
    return { ok: true };
  } catch (err) {
    if (String(err?.code ?? "").startsWith("SQLITE_CONSTRAINT")) return { ok: false, code: "chunk_exists" };
    throw err;
  }
}

export function getChunk(handle, { captureId, seq }) {
  return deserializeChunk(
    handle.prepare("SELECT * FROM voice_capture_chunks WHERE capture_id = ? AND seq = ?").get(captureId, seq),
  );
}

/**
 * Mark a chunk as being transcribed (reserve attempts BEFORE the upstream call).
 *
 * The attempt ceiling lives HERE, not in the route: "retry twice" is a property
 * of the stored slice, and a caller that forgets to count would otherwise bill
 * an hour of retries against a permanently broken slice.
 */
export function beginChunk(handle, { captureId, seq, maxAttempts = CAPTURE_DEFAULTS.maxAttempts, now = Date.now() }) {
  const current = handle
    .prepare("SELECT status, attempts FROM voice_capture_chunks WHERE capture_id = ? AND seq = ?")
    .get(captureId, seq);
  if (!current) return { ok: false, code: "chunk_not_found" };
  if (current.status === "done") return { ok: false, code: "chunk_not_retryable" };
  if (current.status === "transcribing") return { ok: false, code: "chunk_busy" };
  if (current.attempts >= maxAttempts) return { ok: false, code: "chunk_retry_exhausted" };
  const changed = handle
    .prepare(
      `UPDATE voice_capture_chunks SET status = 'transcribing', attempts = attempts + 1, transcribing_at = ?
        WHERE capture_id = ? AND seq = ? AND status IN ('pending', 'failed')`,
    )
    .run(now, captureId, seq);
  if (changed.changes === 0) return { ok: false, code: "chunk_not_retryable" };
  return { ok: true, attempts: getChunk(handle, { captureId, seq })?.attempts ?? 1 };
}

/**
 * What a chunk's segment array is allowed to become in storage (D7).
 *
 * `speaker` is filled ONLY when every segment names the same real speaker:
 *  · the sentinel ("UNKNOWN") is not a name — it means "we could not tell", so it
 *    stores as NULL, which every reader already treats as unknown;
 *  · a chunk that genuinely holds two voices stores NULL too. Collapsing it into
 *    one name is the exact failure this capability exists to prevent, and the raw
 *    array survives in `segments_json` so the merge can still use the detail.
 *
 * `end_ms` is ABSOLUTE in the capture timeline: the chunk's client-reported start
 * plus the last segment's offset inside the chunk. Falls back to start+duration
 * when the array carries no finite end, and NULL when neither is known.
 */
export function deriveChunkSegments({ segments, startMs = null, durationMs = null }) {
  const list = Array.isArray(segments) ? segments.filter((s) => s && typeof s === "object") : [];
  if (!list.length) return { speaker: null, endMs: null, segmentsJson: null };

  const names = new Set();
  for (const s of list) {
    const name = typeof s.speaker === "string" ? s.speaker.trim() : "";
    if (name && name !== SPEAKER_UNKNOWN) names.add(name.slice(0, 64));
  }
  const speaker = names.size === 1 ? [...names][0] : null;

  let lastEnd = null;
  for (const s of list) {
    if (Number.isFinite(s.endMs) && (lastEnd === null || s.endMs > lastEnd)) lastEnd = s.endMs;
  }
  const base = Number.isFinite(startMs) ? startMs : null;
  let endMs = null;
  if (base !== null && lastEnd !== null) endMs = base + lastEnd;
  else if (base !== null && Number.isFinite(durationMs)) endMs = base + durationMs;

  return { speaker, endMs, segmentsJson: JSON.stringify(list) };
}

export function finishChunk(handle, { captureId, seq, ok, text = "", errorCode = null, segments = null, now = Date.now() }) {
  // Audio survives a FAILURE (a retry must not need a second upload) and dies
  // with a SUCCESS unless the capture asked to retain it.
  const retain = handle.prepare("SELECT retain_audio_ms FROM voice_captures WHERE id = ?").get(captureId)?.retain_audio_ms ?? 0;
  if (ok) {
    const dropAudio = retain <= 0;
    const current = handle
      .prepare("SELECT start_ms, duration_ms FROM voice_capture_chunks WHERE capture_id = ? AND seq = ?")
      .get(captureId, seq);
    const derived = deriveChunkSegments({
      segments,
      startMs: current?.start_ms ?? null,
      durationMs: current?.duration_ms ?? null,
    });
    handle
      .prepare(
        `UPDATE voice_capture_chunks
            SET status = 'done', text = ?, error_code = NULL, transcribed_at = ?, transcribing_at = NULL,
                speaker = ?, end_ms = ?, segments_json = ?${dropAudio ? ", audio = NULL" : ""}
          WHERE capture_id = ? AND seq = ?`,
      )
      .run(text, now, derived.speaker, derived.endMs, derived.segmentsJson, captureId, seq);
  } else {
    handle
      .prepare(
        `UPDATE voice_capture_chunks SET status = 'failed', text = '', error_code = ?, transcribing_at = NULL
          WHERE capture_id = ? AND seq = ?`,
      )
      .run(errorCode, captureId, seq);
  }
  return { ok: true };
}

/** Duration accounting, from client-reported starts (3.1) or a byte estimate. */
export function durationOfChunks(rows) {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  let total = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const own = sorted[i].duration_ms;
    if (Number.isFinite(own) && own > 0) {
      total += own;
      continue;
    }
    const next = sorted[i + 1];
    if (next) {
      total += Math.max(0, next.start_ms - sorted[i].start_ms);
      continue;
    }
    // Last slice without a declared duration: 48kbps mono ≈ 6 kB/s.
    total += Math.round(((sorted[i].bytes ?? 0) / 6000) * 1000);
  }
  return total;
}

/** The two budget gates (4.1). Returns the tripped field, or null. */
export function budgetGate(capture) {
  if (capture.used.minutes >= capture.budget.minutes) return "minutes";
  if (capture.used.usd >= capture.budget.usd) return "usd";
  return null;
}

/**
 * mergeChunks — the deterministic pure function (3.2/3.3).
 *
 * Order comes from `seq`; the printed offset comes from the CLIENT's start_ms.
 * Boundary handling: slices are joined with the smallest separator their two
 * edges need, and an overlap (the same words transcribed at the tail of one
 * slice and the head of the next) is removed once — never duplicated, never
 * swallowed.
 *
 * `labelOf` (optional, 3.3) answers a DISPLAY label for a slice, or null when the
 * speaker is not known. A label is written ONLY where the speaker changes between
 * adjacent slices, and only when both sides have one:
 *   • all-unknown captures produce byte-identical text to the pre-change line, and
 *     a single-speaker capture produces no marker at all (there is no boundary to
 *     mark) — the two cases the spec pins;
 *   • an unknown stretch never gets an invented label, because the spec forbids
 *     pseudo-labels ("说话人 1" with no source) outright.
 */
export function mergeChunks(chunks, { labelOf = null } = {}) {
  const rows = [...chunks].filter((c) => c && c.status === "done").sort((a, b) => a.seq - b.seq);
  const segments = [];
  let acc = "";
  let previousLabel = null;
  for (const row of rows) {
    const text = String(row.text ?? "").trim();
    // A silent slice contributes nothing — not an empty line, not a gap marker.
    if (!text) continue;
    const label = typeof labelOf === "function" ? (labelOf(row) ?? null) : null;
    const changed = Boolean(label) && Boolean(previousLabel) && label !== previousLabel;
    if (!acc) {
      acc = text;
    } else {
      const overlap = overlapLength(acc, text);
      const head = text.slice(overlap);
      if (head) {
        const separator = separatorFor(acc, head);
        acc = changed ? acc + separator + `【${label}】` + separator + head : acc + separator + head;
      }
    }
    if (label) previousLabel = label;
    segments.push({ seq: row.seq, startMs: row.start_ms, text, speaker: label });
  }
  return { text: acc, segments };
}

/**
 * Join transcript pieces the way the merge always has: dedupe the seam overlap,
 * add a space only between Latin fragments.
 *
 * Exported because the room landing (capture-room-messages.js) joins a
 * SPEAKER's pieces without the labels, and two joiners would drift — one of them
 * would eventually stop deduping overlaps and every capture would read with the
 * last word repeated at each slice seam.
 */
export function joinTranscripts(pieces = []) {
  let acc = "";
  for (const piece of pieces) {
    const text = String(piece ?? "").trim();
    if (!text) continue;
    if (!acc) {
      acc = text;
      continue;
    }
    const head = text.slice(overlapLength(acc, text));
    if (head) acc += separatorFor(acc, head) + head;
  }
  return acc;
}

/** Longest tail-of-a == head-of-b run (capped; CJK has no word spaces). */
function overlapLength(a, b) {
  const max = Math.min(48, a.length, b.length);
  for (let n = max; n >= 4; n -= 1) {
    if (a.slice(-n) === b.slice(0, n)) return n;
  }
  return 0;
}

/** Latin text needs a space at the seam; CJK does not. */
function separatorFor(prev, next) {
  const last = prev.slice(-1);
  const first = next.slice(0, 1);
  const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
  if (cjk.test(last) || cjk.test(first)) return "";
  if (/[\s.,!?;:)]/.test(last) || /[.,!?;:]/.test(first)) return "";
  return " ";
}

/** Finish = merge once, store both the merge and its pristine copy (3.4). */
/**
 * The seat bindings for one capture, or an empty map when the attribution tables
 * are not there yet (a capture can finish before anyone ever opens the view, and
 * a missing table must not fail the merge — it only means "nothing is bound").
 */
function safeBindings(handle, captureId) {
  try {
    return bindingsMap(handle, { captureId });
  } catch {
    return new Map();
  }
}

/**
 * The merged text and its per-segment speakers, recomputed from stored rows.
 *
 * `finishCapture` writes this once; the room landing needs the same view later
 * (a capture can be sent to a room long after it finished). Re-deriving it with
 * a second set of rules is how a transcript and its labels end up disagreeing.
 */
export function mergedView(handle, capture) {
  const rows = handle.prepare("SELECT * FROM voice_capture_chunks WHERE capture_id = ? ORDER BY seq").all(capture.id);
  // 3.3: the export and the room message read this ONE artifact, so the speaker
  // has to reach it here. Identity comes only from the two legal sources — a seat
  // binding for that cluster, or the capture's own session declaration. A cluster
  // nobody bound stays unlabelled (the spec forbids pseudo-labels), which is also
  // why an all-unknown capture renders byte-identically to the pre-change text.
  const bound = safeBindings(handle, capture.id);
  const sessionLabel = capture.speakerMode === "session" ? (capture.owner ?? null) : null;
  const labelOf = (row) => {
    if (sessionLabel) return sessionLabel;
    if (!row.speaker) return null;
    return bound.get(row.speaker) ?? null;
  };
  return { rows, merged: mergeChunks(rows.map(deserializeChunkWithMeta), { labelOf }) };
}

export function finishCapture(handle, { id, owner, now = Date.now() }) {
  const capture = getCapture(handle, { id, owner, now });
  if (!capture) return { ok: false, code: "not_found" };
  if (capture.status === "abandoned") return { ok: false, code: "not_found" };
  if (capture.status === "finished") return { ok: true, capture, already: true };

  const { rows, merged } = mergedView(handle, capture);
  const minutes = durationOfChunks(rows) / 60_000;
  handle
    .prepare(
      `UPDATE voice_captures SET status = 'finished', finished_at = ?, merged_text = ?, original_text = ?, minutes_used = ?
        WHERE id = ?`,
    )
    .run(now, merged.text, merged.text, minutes, id);
  return { ok: true, capture: getCapture(handle, { id, owner, now }), segments: merged.segments };
}

function deserializeChunkWithMeta(row) {
  return {
    seq: row.seq,
    start_ms: row.start_ms,
    end_ms: row.end_ms ?? null,
    status: row.status,
    text: row.text,
    speaker: row.speaker ?? null,
    segments_json: row.segments_json ?? null,
  };
}

/** One human correction; the merged original stays readable (3.4). */
export function correctCapture(handle, { id, owner, text, now = Date.now() }) {
  const capture = getCapture(handle, { id, owner, now });
  if (!capture || capture.status !== "finished") return { ok: false, code: "not_finished" };
  if (capture.correctedAt != null) return { ok: false, code: "already_corrected" };
  handle
    .prepare("UPDATE voice_captures SET merged_text = ?, corrected_at = ?, original_text = COALESCE(original_text, merged_text) WHERE id = ?")
    .run(String(text).slice(0, 200_000), now, id);
  return { ok: true, capture: getCapture(handle, { id, owner, now }) };
}

/** Abandon = stop accepting AND delete audio + text (distinct from finish). */
export function abandonCapture(handle, { id, owner, now = Date.now() }) {
  const capture = getCapture(handle, { id, owner, now });
  if (!capture) return { ok: false, code: "not_found" };
  handle.prepare("DELETE FROM voice_capture_chunks WHERE capture_id = ?").run(id);
  handle
    .prepare("UPDATE voice_captures SET status = 'abandoned', merged_text = NULL, original_text = NULL WHERE id = ?")
    .run(id);
  return { ok: true };
}

/** Idempotent retention sweep (4.2): expire recordings, free wedged slices, purge stale audio. */
export function sweepCaptures(handle, { now = Date.now(), staleTranscribingMs = 10 * 60_000 } = {}) {
  // A slice in `transcribing` whose request died (process restart, dropped
  // connection) can never be retried: beginChunk refuses it as busy forever.
  // Freeing it is the retry path D6 asks for, for the failure that can actually
  // happen — the delete itself is in the same statement as `status='done'`, so
  // it has no separate failure mode to queue.
  const requeued = handle
    .prepare(
      `UPDATE voice_capture_chunks
          SET status = 'failed', error_code = 'stale_transcribing', transcribing_at = NULL
        WHERE status = 'transcribing' AND transcribing_at IS NOT NULL AND transcribing_at <= ?`,
    )
    .run(now - staleTranscribingMs).changes;

  // Expiry is a status fact; the audio sweep is separate and respects each
  // capture's own retain window (a global "purge everything retained" would
  // delete audio that was explicitly asked to be kept for another hour).
  const expired = handle
    .prepare("UPDATE voice_captures SET status = 'expired' WHERE status = 'recording' AND expires_at <= ?")
    .run(now).changes;
  const purgedAudio = handle
    .prepare(
      `UPDATE voice_capture_chunks SET audio = NULL
        WHERE audio IS NOT NULL
          AND capture_id IN (
            SELECT id FROM voice_captures
             WHERE retain_audio_ms > 0 AND created_at + retain_audio_ms <= ?
          )`,
    )
    .run(now).changes;
  return { expired, purgedAudio, requeued };
}
