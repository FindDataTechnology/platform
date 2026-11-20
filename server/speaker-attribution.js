// server/speaker-attribution.js — who said which slice, to the degree that
// answer can be CHECKED AND CHANGED (openspec: add-speaker-attribution, 2.x–6.x).
//
// The ladder this module implements is a trust ladder, not a feature list:
//
//   L0 session  — the speaker was on their own authenticated device. Certain
//                 without inference, so it needs no de-risking: `certainty=session`.
//   L1 cluster  — anonymous `speaker_1..n` from upstream separation. NO identity
//                 is inferred. (The probe found the current lane returns no
//                 speaker information at all — docs/voice-diarization-probe.md —
//                 so this path is off by default and marked `anonymous`.)
//   L2 binding  — a human says "speaker_2 is B". `certainty=bound`.
//   L3 voiceprint — NOT here, not by default, ever (a biometric identifier is an
//                 authentication factor, and this product's voice lane is not).
//
// Two invariants carry the whole point of the capability:
//   1. Anything below `bound` is NOT dispatched automatically. A guess must never
//      decide who receives a recording of a private conversation.
//   2. The attribution artifact carries no biometric material — no vector, no
//      embedding, no audio. Only a cluster id, a time span, a member, a certainty
//      and a readable basis. `assertNoBiometrics` is the gate.
//
// Nothing here is retroactive: changing a binding updates the VIEW, never a
// dispatch that already happened (5.3). The audit trail is what makes that
// claim checkable.

import { randomUUID } from "node:crypto";

/** The three certainties, weakest last. Dispatch admission reads this order. */
export const CERTAINTY_LEVELS = Object.freeze(["session", "bound", "anonymous"]);

/** Only these two may dispatch without a human confirming (6.1). */
export const DISPATCHABLE_CERTAINTY = Object.freeze(["session", "bound"]);

export const CLUSTER_SESSION = "session";
export const CLUSTER_ANONYMOUS = "anonymous";

/**
 * The lane's "I could not tell who this was" label — a SENTINEL, not a name.
 *
 * It is defined here (the module that owns the attribution vocabulary) because
 * two places need it and a second copy would diverge silently: the transcription
 * route degrades to it when the upstream returns no speaker, and the capture
 * store must treat it as "unknown" (SQL NULL) rather than write it into a
 * `speaker` column as if a person were called UNKNOWN. A wrong attribution is
 * worse than none (D8).
 */
export const SPEAKER_UNKNOWN = "UNKNOWN";

/** Basis strings are user-facing; they live in the artifact, not in a log. */
export const BASIS = Object.freeze({
  session: "说话者在其已登录设备上直接录音",
  anonymousNoDiarization: "本场未做分离（上游不返回说话人信息）",
  anonymousMultiPerson: "该段可能有多人，未强行归给某一位",
  bound: "由成员人工贴名",
  // 3.2: the lane's segments did not rebuild the chunk's text. The whole slice is
  // used as one unit and the reason travels with the row — refusing to split is
  // the honest answer, because a split assembled from words the transcript does
  // not contain would read as confident attribution built on nothing.
  segmentTextMismatch: "分段与转录文本不一致，已退回整段（未按分段硬拼）",
});

/**
 * Field names that would turn the artifact into a biometric record (2.2).
 * Matched case-insensitively against every key in a candidate payload.
 */
export const FORBIDDEN_FIELDS = Object.freeze([
  "vector",
  "vectors",
  "embedding",
  "embeddings",
  "feature",
  "features",
  "voiceprint",
  "voice_print",
  "xvector",
  "dvector",
  "mfcc",
  "spectrogram",
  "waveform",
  "audio",
  "audiob64",
  "pcm",
]);

/**
 * Refuse an artifact that carries biometric material.
 *
 * Returns the offending paths instead of throwing so a caller can name them in a
 * refusal body — "invalid" with no address is the least actionable error there is.
 */
export function assertNoBiometrics(payload) {
  const hits = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${prefix}[${i}]`);
      });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = prefix ? `${prefix}.${key}` : key;
      if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) hits.push(at);
      walk(value, at);
    }
  };
  walk(payload, "");
  return hits.length ? { ok: false, offending: hits } : { ok: true };
}

export function ensureSpeakerTables(handle) {
  handle.exec(`CREATE TABLE IF NOT EXISTS speaker_attributions (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    cluster TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER,
    member TEXT,
    certainty TEXT NOT NULL,
    basis TEXT NOT NULL,
    -- A conflict is a ROW, not a silent overwrite: session identity wins, and
    -- the disagreement is readable afterwards (3.2).
    conflict TEXT,
    created_at INTEGER NOT NULL
  )`);
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_speaker_attr_capture ON speaker_attributions(capture_id, start_ms)`,
  );
  // One binding per cluster per capture — and because the key includes the
  // capture, a binding can never leak into the next recording (5.4).
  handle.exec(`CREATE TABLE IF NOT EXISTS speaker_bindings (
    capture_id TEXT NOT NULL,
    cluster TEXT NOT NULL,
    member TEXT NOT NULL,
    bound_by TEXT NOT NULL,
    bound_at INTEGER NOT NULL,
    PRIMARY KEY (capture_id, cluster)
  )`);
  handle.exec(`CREATE TABLE IF NOT EXISTS speaker_binding_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    cluster TEXT NOT NULL,
    op TEXT NOT NULL,
    from_member TEXT,
    to_member TEXT,
    actor TEXT NOT NULL,
    at INTEGER NOT NULL
  )`);
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_speaker_events_capture ON speaker_binding_events(capture_id, at)`,
  );
}

// ── cluster normalisation (2.3) ─────────────────────────────────────────────

/**
 * Turn raw separation output into stable anonymous clusters.
 *
 * Determinism is the requirement: the same input must number the same clusters
 * the same way, because `speaker_2` is what a human will later click on. So the
 * order is (start time, then end time, then original index) — never insertion
 * order, never a hash, never a random tiebreak.
 */
export function normalizeClusters(rawSegments) {
  const rows = (Array.isArray(rawSegments) ? rawSegments : [])
    .map((s, i) => ({
      rawSpeaker: String(s?.speaker ?? s?.speakerId ?? s?.speaker_id ?? "").trim(),
      startMs: Number(s?.startMs ?? s?.start_ms ?? (Number(s?.start) || 0) * 1000) || 0,
      endMs: Number(s?.endMs ?? s?.end_ms ?? (Number(s?.end) || 0) * 1000) || 0,
      index: i,
    }))
    .filter((s) => s.rawSpeaker)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.index - b.index);

  const numbered = new Map();
  const out = [];
  for (const row of rows) {
    if (!numbered.has(row.rawSpeaker)) numbered.set(row.rawSpeaker, `speaker_${numbered.size + 1}`);
    out.push({ cluster: numbered.get(row.rawSpeaker), startMs: row.startMs, endMs: row.endMs });
  }
  return out;
}

// ── derivation (3.1 / 3.2 / 4.2 / 4.4) ──────────────────────────────────────

/**
 * Build the attribution rows for one capture.
 *
 * @param sessionMember  the authenticated speaker of the device that recorded
 *                       (L0), or null when the capture came from a shared mic.
 * @param chunks          the capture's slices: {seq, startMs, durationMs, text, status}
 * @param diarization     raw separation output, when available. Absent is the
 *                       normal case: the lane returns plain text.
 * @param bindings        existing cluster → member bindings for this capture.
 */
/**
 * Compare texts the way a human would: whitespace (including the newlines both
 * lanes like to insert) carries no meaning here, but every character does.
 */
function comparableText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/**
 * Split ONE chunk into the ordered slices the merge works on (3.2).
 *
 * Text is the authority. When the lane returns segments, their texts must rebuild
 * the chunk's own text; if they do not, the chunk is used whole and the reason is
 * recorded — never a split assembled from words the transcript does not contain.
 *
 * Offsets: a segment's `startMs`/`endMs` are relative to the chunk audio, so they
 * are added to the chunk's CLIENT-REPORTED start. The chunk's stored `end_ms` (D7)
 * wins over `start + duration` when present, and clamps segment ends so a bad
 * upstream offset cannot claim time outside its own slice.
 */
function slicesOfChunk(chunk) {
  const eseq = chunk.seq;
  const baseStart = Number(chunk.startMs ?? chunk.start_ms ?? 0) || 0;
  const durationMs = Number(chunk.durationMs ?? chunk.duration_ms ?? 0) || 0;
  const storedEnd = Number(chunk.endMs ?? chunk.end_ms);
  const chunkEnd = Number.isFinite(storedEnd) ? storedEnd : baseStart + durationMs;
  const text = String(chunk.text ?? "");
  const chunkSpeaker = typeof chunk.speaker === "string" && chunk.speaker.trim() ? chunk.speaker.trim() : null;
  const segments = Array.isArray(chunk.segments) ? chunk.segments.filter((s) => s && typeof s === "object") : [];

  const whole = (degraded) => [
    { eseq, part: 0, startMs: baseStart, endMs: chunkEnd, speaker: chunkSpeaker, text, degraded },
  ];

  if (!segments.length) return whole(null);

  const rebuilt = comparableText(segments.map((s) => s.text).join(""));
  if (rebuilt !== comparableText(text)) return whole(BASIS.segmentTextMismatch);

  return segments.map((s, part) => {
    const relStart = Number.isFinite(s.startMs) ? s.startMs : null;
    const relEnd = Number.isFinite(s.endMs) ? s.endMs : null;
    const startMs = relStart === null ? baseStart : baseStart + relStart;
    const endMs = relEnd === null ? chunkEnd : Math.min(baseStart + relEnd, chunkEnd);
    const raw = typeof s.speaker === "string" ? s.speaker.trim() : "";
    // The sentinel is not a cluster: it is the absence of one.
    const speaker = raw && raw !== SPEAKER_UNKNOWN ? raw.slice(0, 64) : null;
    return { eseq, part, startMs, endMs, speaker, text: String(s.text ?? ""), degraded: null };
  });
}

/**
 * Which speaker clusters touch this slice?
 *
 * The stored `speaker` is a CLUSTER ID, not a person: it becomes an identity only
 * through a seat binding or the capture's own session declaration (the spec allows
 * exactly those two sources). When the lane gave no speaker we fall back to the
 * diarization overlaps the caller passed — that is how this merge worked before
 * segments existed, and callers that still pass `diarization` keep their meaning.
 */
function clustersOfSlice(slice, clusters) {
  if (slice.speaker) return [slice.speaker];
  return [...new Set(clusters.filter((c) => c.startMs < slice.endMs && c.endMs > slice.startMs).map((c) => c.cluster))];
}

export function deriveAttributions({ sessionMember = null, chunks = [], diarization = [], bindings = new Map() }) {
  const spoken = chunks
    .filter((c) => c && c.status === "done" && String(c.text ?? "").trim())
    .flatMap(slicesOfChunk)
    .sort((a, b) => a.startMs - b.startMs || a.eseq - b.eseq || a.part - b.part);

  const clusters = normalizeClusters(diarization);

  return spoken.map((slice) => {
    // Which clusters overlap this slice? A slice with two clusters in it is a
    // slice where multiple people spoke — refused an identity rather than
    // assigned to whichever cluster came first (4.4).
    const distinct = clustersOfSlice(slice, clusters);

    if (sessionMember) {
      // L0 wins over any separation result, and the disagreement is recorded.
      const disagreed = distinct.filter((cl) => {
        const bound = bindings.get(cl);
        return bound && bound.toLowerCase() !== sessionMember.toLowerCase();
      });
      return {
        cluster: CLUSTER_SESSION,
        startMs: slice.startMs,
        endMs: slice.endMs,
        member: sessionMember,
        certainty: "session",
        basis: BASIS.session,
        conflict: disagreed.length
          ? { clusters: disagreed, note: "分离结果与该段会话身份不一致，已按会话身份归属" }
          : null,
      };
    }

    if (!distinct.length) {
      // No separation available: say so. Never invent a cluster, never present
      // "not separated" as "only one person spoke" (4.2).
      return {
        cluster: CLUSTER_ANONYMOUS,
        startMs: slice.startMs,
        endMs: slice.endMs,
        member: null,
        certainty: "anonymous",
        basis: slice.degraded ?? BASIS.anonymousNoDiarization,
        conflict: null,
      };
    }

    if (distinct.length > 1) {
      return {
        cluster: CLUSTER_ANONYMOUS,
        startMs: slice.startMs,
        endMs: slice.endMs,
        member: null,
        certainty: "anonymous",
        basis: BASIS.anonymousMultiPerson,
        conflict: null,
      };
    }

    const cluster = distinct[0];
    const bound = bindings.get(cluster) ?? null;
    return {
      cluster,
      startMs: slice.startMs,
      endMs: slice.endMs,
      member: bound,
      certainty: bound ? "bound" : "anonymous",
      basis: bound ? BASIS.bound : (slice.degraded ?? "匿名簇，尚未贴名"),
      conflict: null,
    };
  });
}

/** Persist derived rows for a capture, replacing any previous derivation. */
export function writeAttributions(handle, { captureId, owner, rows, now = Date.now() }) {
  const guarded = assertNoBiometrics({ rows });
  if (!guarded.ok) return { ok: false, code: "biometric_field", offending: guarded.offending };
  ensureSpeakerTables(handle);
  handle.prepare("DELETE FROM speaker_attributions WHERE capture_id = ?").run(captureId);
  const insert = handle.prepare(
    `INSERT INTO speaker_attributions
      (id, capture_id, owner, cluster, start_ms, end_ms, member, certainty, basis, conflict, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      `spk_${randomUUID()}`,
      captureId,
      owner,
      row.cluster,
      row.startMs,
      row.endMs,
      row.member,
      row.certainty,
      row.basis,
      row.conflict ? JSON.stringify(row.conflict) : null,
      now,
    );
  }
  return { ok: true, written: rows.length };
}

export function listAttributions(handle, { captureId }) {
  ensureSpeakerTables(handle);
  return handle
    .prepare("SELECT * FROM speaker_attributions WHERE capture_id = ? ORDER BY start_ms, cluster")
    .all(captureId)
    .map((r) => ({
      cluster: r.cluster,
      startMs: r.start_ms,
      endMs: r.end_ms,
      member: r.member,
      certainty: r.certainty,
      basis: r.basis,
      conflict: r.conflict ? JSON.parse(r.conflict) : null,
    }));
}

/** Conflict rows only — the "异常条目" a surface must show rather than hide. */
export function listConflicts(handle, { captureId }) {
  return listAttributions(handle, { captureId }).filter((r) => r.conflict);
}

// ── binding (5.1–5.4) ───────────────────────────────────────────────────────

/**
 * Bind one cluster to one member.
 *
 * `allowedMembers` is the room's present members: a binding to someone who was
 * not there is refused with the reason, because otherwise a typo becomes a
 * standing claim about who said what.
 */
export function bindCluster(
  handle,
  { captureId, owner, cluster, member, actor, allowedMembers = null, now = Date.now() },
) {
  ensureSpeakerTables(handle);
  const wanted = String(member ?? "").trim().toLowerCase();
  if (!wanted) return { ok: false, code: "member_required" };
  if (!String(cluster ?? "").trim()) return { ok: false, code: "cluster_required" };
  if (cluster === CLUSTER_SESSION) return { ok: false, code: "cluster_not_bindable" };
  if (allowedMembers && !allowedMembers.map((m) => String(m).trim().toLowerCase()).includes(wanted)) {
    return { ok: false, code: "member_not_present", detail: { member: wanted } };
  }

  const existing = handle
    .prepare("SELECT member FROM speaker_bindings WHERE capture_id = ? AND cluster = ?")
    .get(captureId, cluster);
  const op = existing ? "rebind" : "bind";

  handle
    .prepare(
      `INSERT INTO speaker_bindings (capture_id, cluster, member, bound_by, bound_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(capture_id, cluster) DO UPDATE SET member = excluded.member,
         bound_by = excluded.bound_by, bound_at = excluded.bound_at`,
    )
    .run(captureId, cluster, wanted, actor ?? owner ?? "", now);
  handle
    .prepare(
      `INSERT INTO speaker_binding_events (capture_id, cluster, op, from_member, to_member, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(captureId, cluster, op, existing?.member ?? null, wanted, actor ?? owner ?? "", now);

  // The VIEW follows the binding; nothing already dispatched is rewritten (5.3).
  refreshClusterRows(handle, { captureId, cluster, member: wanted, now });
  return { ok: true, op, cluster, member: wanted, previous: existing?.member ?? null };
}

/** Unbind: the cluster goes back to anonymous, and the trail says who undid it. */
export function unbindCluster(handle, { captureId, cluster, actor, now = Date.now() }) {
  ensureSpeakerTables(handle);
  const existing = handle
    .prepare("SELECT member FROM speaker_bindings WHERE capture_id = ? AND cluster = ?")
    .get(captureId, cluster);
  if (!existing) return { ok: false, code: "not_bound" };
  handle.prepare("DELETE FROM speaker_bindings WHERE capture_id = ? AND cluster = ?").run(captureId, cluster);
  handle
    .prepare(
      `INSERT INTO speaker_binding_events (capture_id, cluster, op, from_member, to_member, actor, at)
       VALUES (?, ?, 'unbind', ?, NULL, ?, ?)`,
    )
    .run(captureId, cluster, existing.member, actor ?? "", now);
  refreshClusterRows(handle, { captureId, cluster, member: null, now });
  return { ok: true, cluster, previous: existing.member };
}

/** Apply a binding change to the rows of one cluster only. */
function refreshClusterRows(handle, { captureId, cluster, member, now }) {
  handle
    .prepare(
      `UPDATE speaker_attributions
          SET member = ?, certainty = ?, basis = ?
        WHERE capture_id = ? AND cluster = ?`,
    )
    .run(member, member ? "bound" : "anonymous", member ? BASIS.bound : "匿名簇，尚未贴名", captureId, cluster);
  void now;
}

export function listBindings(handle, { captureId }) {
  ensureSpeakerTables(handle);
  return handle
    .prepare("SELECT cluster, member, bound_by, bound_at FROM speaker_bindings WHERE capture_id = ? ORDER BY cluster")
    .all(captureId)
    .map((r) => ({ cluster: r.cluster, member: r.member, boundBy: r.bound_by, boundAt: r.bound_at }));
}

export function bindingsMap(handle, { captureId }) {
  return new Map(listBindings(handle, { captureId }).map((b) => [b.cluster, b.member]));
}

export function listBindingEvents(handle, { captureId }) {
  ensureSpeakerTables(handle);
  return handle
    .prepare("SELECT cluster, op, from_member, to_member, actor, at FROM speaker_binding_events WHERE capture_id = ? ORDER BY at, id")
    .all(captureId)
    .map((r) => ({ cluster: r.cluster, op: r.op, from: r.from_member, to: r.to_member, actor: r.actor, at: r.at }));
}

// ── dispatch admission (6.1) ────────────────────────────────────────────────

/**
 * May this attribution dispatch without a human?
 *
 * `anonymous` always lands in the confirmation queue — that is the requirement,
 * and it does not bend for a "probably right" guess. With no team there is
 * nobody to dispatch to, which is a different answer from "not allowed".
 */
export function decideDispatch({ certainty, hasTeam = true }) {
  if (!DISPATCHABLE_CERTAINTY.includes(certainty)) {
    return {
      dispatch: false,
      reason: "needs_confirmation",
      code: "attribution_uncertain",
      detail: { certainty },
    };
  }
  if (!hasTeam) return { dispatch: false, reason: "no_team", code: "no_reception" };
  return { dispatch: true, reason: "ok", code: null };
}

/**
 * The gate for one capture's segments, in order. Pure so the three-certainty ×
 * with/without-team matrix is a test, not a hope.
 */
export function planDispatch(rows, { hasTeam = true } = {}) {
  return rows.map((row) => ({
    ...row,
    decision: decideDispatch({ certainty: row.certainty, hasTeam }),
  }));
}

// ── retention (7.3) ─────────────────────────────────────────────────────────

/** Attribution dies with its capture — no orphan clusters, no orphan bindings. */
export function purgeAttributions(handle, { captureId }) {
  ensureSpeakerTables(handle);
  const rows = handle.prepare("DELETE FROM speaker_attributions WHERE capture_id = ?").run(captureId).changes;
  const bindings = handle.prepare("DELETE FROM speaker_bindings WHERE capture_id = ?").run(captureId).changes;
  const events = handle.prepare("DELETE FROM speaker_binding_events WHERE capture_id = ?").run(captureId).changes;
  return { rows, bindings, events };
}

/** A summary a surface can render without loading every row. */
export function attributionSummary(rows) {
  const counts = { session: 0, bound: 0, anonymous: 0 };
  for (const r of rows) counts[r.certainty] = (counts[r.certainty] ?? 0) + 1;

  // Separation status is a THIRD answer alongside the per-row certainties, and
  // it exists so a partially-separated capture cannot be rendered as a fully
  // separated one (4.3): some slices have real clusters, the rest fell back.
  const nonSession = rows.filter((r) => r.cluster !== CLUSTER_SESSION);
  const clustered = nonSession.filter((r) => r.cluster !== CLUSTER_ANONYMOUS).length;
  let separation;
  if (!nonSession.length) separation = "not_needed"; // every row was L0
  else if (clustered === nonSession.length) separation = "full";
  else if (clustered === 0) separation = "none";
  else separation = "partial";

  return {
    total: rows.length,
    ...counts,
    separation,
    separated: separation === "full",
    dispatchable: counts.session + counts.bound,
    needsConfirmation: counts.anonymous,
    conflicts: rows.filter((r) => r.conflict).length,
  };
}
