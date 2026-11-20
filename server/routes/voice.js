// routes/voice.js — the voice lane (voice-lane, L2b): speech in, speech out,
// over ONE fixed protocol.
//
// The browser only ever talks to /api/voice/*; this module forwards to the
// 词元 audio lane using the OpenAI-compatible audio endpoints and nothing
// else. Which upstream actually transcribes or synthesises (Doubao, Tencent,
// SiliconFlow…) is configured on the 词元 side per account (audio-lane-
// multi-upstream) — the platform neither knows nor cares (design D1).
//
// The forwarding key follows the model lane (design D2): the requesting
// user's bound 词元 account key first (usage bills their account), then the
// deployment key. It never reaches the browser. An upstream 401/403 on the
// user's key marks the binding stale exactly like a 401 from the operations
// MCP does, and the response carries the same connect pointer the chat uses
// (chat-connect-guidance) so the UI can offer the 词元 card.
//
// The `voice` configuration block is deployment config (design D3): stored
// JSON → VOICE_CONFIG env seed → defaults, admin-writable, read by every
// client through /api/voice/status (no key material in the read).

import multer from "multer";
import { GATEWAY_SECRET_HEADER } from "../auth.js";
import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";
import * as db from "../../db.js";
import * as ciyuanAccount from "../../ciyuan-account-credentials.js";
import {
  deriveCapture,
  registerSpeakerAttributionRoutes,
  syncPendingAttribution,
} from "./speaker-attribution.js";
import { purgeAttributions, SPEAKER_UNKNOWN } from "../speaker-attribution.js";
import {
  CAPTURE_DEFAULTS,
  abandonCapture,
  beginChunk,
  budgetGate,
  checkTimeline,
  correctCapture,
  createCapture,
  durationOfChunks,
  ensureVoiceCaptureTables,
  finishCapture,
  finishChunk,
  getCapture,
  getChunk,
  insertChunk,
  listCaptures,
  listChunks,
  mergedView,
  sweepCaptures,
} from "../voice-capture.js";
import { captureRoomMessages } from "../capture-room-messages.js";
import { ACCEPTED_AUDIO_LABEL, describeContainer, isRejectedContainer, sniffAudioContainer } from "../voice-containers.js";

const DEFAULT_API_BASE = "https://token.finddatatech.cloud";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ASR_TIMEOUT_MS = 120_000; // Doubao ASR is submit+poll on the 词元 side
const TTS_TIMEOUT_MS = 60_000;
const MODEL_FIELD_MAX = 120;
const STALE_EVENT = "line_credential_stale"; // the wanxing-caller ref's event (credential-refs)

export const TTS_MAX_INPUT_CHARS = 4000;
export const TTS_FORMATS = Object.freeze(["mp3", "wav", "opus", "aac", "flac"]);
export const VOICE_DEFAULTS = Object.freeze({
  enabled: true,
  asrModel: "",
  ttsModel: "",
  ttsVoice: "",
  ttsFormat: "mp3",
});
const TTS_MIME = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac" };

export function apiBase() {
  return String(process.env.VOICE_API_BASE || process.env.CIYUAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

// ── configuration ───────────────────────────────────────────────────────────

// Partial merge onto `base`: a present field replaces, an absent one keeps the
// base value, a blank string resets to the default. Unknown keys are rejected
// rather than ignored so a typo cannot silently do nothing.
export function validateVoiceConfig(value, base = VOICE_DEFAULTS) {
  const fail = (error) => ({ ok: false, error });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("voice config must be an object");
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(value)) {
    if (!Object.hasOwn(VOICE_DEFAULTS, k)) return fail(`unknown field '${k}'`);
    if (k === "enabled") {
      if (typeof v !== "boolean") return fail("field 'enabled' must be a boolean");
      out.enabled = v;
      continue;
    }
    if (typeof v !== "string") return fail(`field '${k}' must be a string`);
    const s = v.trim();
    if (s.length > MODEL_FIELD_MAX) return fail(`field '${k}' exceeds ${MODEL_FIELD_MAX} characters`);
    if (k === "ttsFormat") {
      const f = s.toLowerCase();
      if (f && !TTS_FORMATS.includes(f)) return fail(`field 'ttsFormat' must be one of ${TTS_FORMATS.join(", ")}`);
      out.ttsFormat = f || VOICE_DEFAULTS.ttsFormat;
      continue;
    }
    out[k] = s;
  }
  return { ok: true, normalized: out };
}

// Stored → env → defaults. A bad layer degrades to the next one with a
// warning: a hand-written VOICE_CONFIG must never take the composer down.
export function resolveVoiceConfig() {
  const stored = db.isDbReady() ? db.getDeploymentConfig("voice") : null;
  const layers = [
    ["stored", stored],
    ["env", process.env.VOICE_CONFIG],
  ];
  for (const [source, raw] of layers) {
    if (raw === null || raw === undefined || !String(raw).trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      console.warn(`[voice] ${source} config is not valid JSON; ignoring`);
      continue;
    }
    const r = validateVoiceConfig(parsed);
    if (!r.ok) {
      console.warn(`[voice] ${source} config failed validation (${r.error}); ignoring`);
      continue;
    }
    return r.normalized;
  }
  return { ...VOICE_DEFAULTS };
}

// ── credentials ─────────────────────────────────────────────────────────────

function identity(req) {
  return req.ssoUser || req.user || null;
}

// user key → VOICE_API_KEY → LLM_API_KEY (the production model-lane seed, see
// §12.17) → nothing. A stale binding reads as absent (liveToken returns null)
// so the deployment key takes over until the user re-connects. A null email
// (auth off: the machine owner) still resolves — ownerKey maps it to the
// machine-owner row the connect card wrote.
export function resolveVoiceKey(ctx, req) {
  const email = identity(req)?.email || ctx.cellUserEmail || null;
  const userKey = ciyuanAccount.liveToken(email);
  if (userKey) return { key: userKey, source: "user", email };
  const envKey = String(process.env.VOICE_API_KEY || process.env.LLM_API_KEY || "").trim();
  if (envKey) return { key: envKey, source: "deployment", email };
  return { key: null, source: null, email };
}

function requireUser(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

// ── forwarding ──────────────────────────────────────────────────────────────

async function forward(url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A short machine code from the upstream body, if it has one — never the
// body itself (it may echo request details).
async function upstreamCode(upstream) {
  try {
    const text = await upstream.text();
    const j = JSON.parse(text);
    const code = j?.error?.code ?? j?.code ?? j?.error?.type ?? null;
    return typeof code === "string" && code.length <= 64 ? code : null;
  } catch {
    return null;
  }
}

// Cell credential store rewrite after a stale mark — same hook the account
// route uses, so the next model request falls back to the deployment seed.
function rewriteModelLane(ctx) {
  import("../../dsh-profile.js")
    .then((m) => m.ensureCredentialsStore({ cellOwnerEmail: ctx.cellUserEmail || null }))
    .catch((e) => console.warn(`[voice] credential store rewrite failed: ${e?.message || e}`));
}

async function failUpstreamResult(ctx, upstream, keyInfo, lane) {
  const code = await upstreamCode(upstream);
  if (upstream.status === 401 || upstream.status === 403) {
    if (keyInfo.source === "user") {
      if (ciyuanAccount.markStale(keyInfo.email)) {
        ctx.broadcast?.({ type: STALE_EVENT });
        rewriteModelLane(ctx);
      }
      console.warn(`[voice] upstream ${upstream.status} on ${lane} with the user's 词元 key — binding marked stale`);
      return {
        ok: false,
        status: 401,
        body: { error: "词元账号凭据已失效，请重新连接", code: "credential_stale", connect: { panel: "ciyuan-account" } },
      };
    }
    console.warn(`[voice] upstream ${upstream.status} on ${lane} with the deployment key${code ? ` (${code})` : ""}`);
    return { ok: false, status: 502, body: { error: "语音服务拒绝了部署凭据", code: "upstream_unauthorized" } };
  }
  console.warn(`[voice] upstream ${upstream.status} on ${lane}${code ? ` (${code})` : ""}`);
  return {
    ok: false,
    status: 502,
    body: {
      error: "语音服务暂不可用",
      code: "upstream_error",
      upstreamStatus: upstream.status,
      ...(code ? { upstreamCode: code } : {}),
    },
  };
}

function failUnreachableResult(lane, err) {
  const aborted = err?.name === "AbortError";
  console.warn(`[voice] upstream ${aborted ? "timeout" : "unreachable"} on ${lane}: ${err?.message || err}`);
  return {
    ok: false,
    status: 502,
    body: {
      error: aborted ? "语音服务响应超时" : "语音服务不可达",
      code: aborted ? "upstream_timeout" : "upstream_unreachable",
    },
  };
}

/**
 * The one "this deployment cannot transcribe right now" refusal (openspec:
 * add-voice-capture-lane 1.4).
 *
 * The composer lane and the capture lane are two doors to the same upstream, so
 * they must refuse with the same words. Kept as a value-returning helper for the
 * same reason as `transcribeBuffer`: a route writes it, a function returns it.
 */
export function voiceUnavailable(config, keyInfo) {
  if (!config?.enabled) return { status: 503, body: { error: "语音功能已停用", code: "voice_disabled" } };
  if (!keyInfo?.key) return { status: 503, body: { error: "语音服务未配置凭据", code: "voice_not_configured" } };
  return null;
}

/**
 * The "the lane is measured to refuse this container" gate (openspec:
 * fix-voice-transcription-container 4.1).
 *
 * Refusing HERE is not a nicety. A rejected-content 400 from the lane takes the
 * shared audio account out of rotation for about a minute — measured
 * 2026-11-15: the next request with a perfectly good WAV answered 503 for ~60s
 * — so one caller's streaming container breaks transcription for everyone.
 * The accepted/rejected table lives in server/voice-containers.js.
 *
 * Returns null when the container is fine OR unrecognised: the gate refuses
 * only the shapes we have measured, because a gate stricter than the lane would
 * reject audio the lane would have accepted.
 */
export function unsupportedContainerResult(buffer) {
  const container = sniffAudioContainer(buffer);
  if (!isRejectedContainer(container)) return null;
  console.warn(
    `[voice] refused a ${container} upload without calling upstream — the audio lane rejects ${describeContainer(container)} and de-rotates the account for ~1 min after each such 400`,
  );
  return {
    ok: false,
    status: 415,
    body: {
      error: `语音服务不接受 ${describeContainer(container)}，请改用 ${ACCEPTED_AUDIO_LABEL}`,
      code: "unsupported_audio_container",
      container,
      accepted: ACCEPTED_AUDIO_LABEL,
    },
  };
}

/**
 * The transcription call, reusable (openspec: add-voice-capture-lane 1.2).
 *
 * Returns a RESULT instead of writing a response, so the same call can back the
 * composer's single-shot upload AND the capture lane's per-chunk transcription
 * without either growing its own copy of the error mapping. Every body/status
 * below is byte-identical to what the composer route sent before the extraction
 * — the capture lane must not invent a second error vocabulary.
 */
export async function transcribeBuffer({ buffer, mime, filename, config, keyInfo, ctx, wantSegments = false }) {
  const nope = voiceUnavailable(config, keyInfo);
  if (nope) return { ok: false, ...nope };

  // Container gate: a shape the lane will always refuse must never reach it,
  // because each rejected-content 400 costs every caller ~a minute of lane.
  const blocked = unsupportedContainerResult(buffer);
  if (blocked) return blocked;

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), filename || "audio");
  if (config.asrModel) form.append("model", config.asrModel);
  form.append("response_format", wantSegments ? SEGMENTS_RESPONSE_FORMAT : "json");

  let upstream;
  try {
    upstream = await forward(
      `${apiBase()}/v1/audio/transcriptions`,
      { method: "POST", headers: { authorization: `Bearer ${keyInfo.key}` }, body: form },
      ASR_TIMEOUT_MS,
    );
  } catch (e) {
    return failUnreachableResult("transcriptions", e);
  }
  if (!upstream.ok) return failUpstreamResult(ctx, upstream, keyInfo, "transcriptions");
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return { ok: false, status: 502, body: { error: "语音服务返回了无法解析的结果", code: "upstream_malformed" } };
  }
  const text = typeof payload?.text === "string" ? payload.text : "";
  // design D10: the switch must be ANSWERED here, not merely accepted at the
  // route — otherwise `diarize` is passed in and the segments are silently
  // dropped on the capture path.
  if (!wantSegments) return { ok: true, text, keySource: keyInfo.source };
  const normalizedSegments = normalizeSegments(payload, text);
  return {
    ok: true,
    text,
    segments: normalizedSegments.segments,
    ...(normalizedSegments.degraded ? { degraded: normalizedSegments.degraded } : {}),
    keySource: keyInfo.source,
  };
}

// ── segments (speaker-attribution): opt-in, and honest when absent ───────────
//
// Measured 2026-11-13 (add-speaker-attribution, design appendix A): the 词元
// lane ACCEPTS `response_format=verbose_json` and answers 200 with `{text}`
// only — no `segments`, no `words`, no timestamps; `diarized_json` is rejected
// with 400. So "the request succeeded" never means "we got segments", and the
// only honest capability test is whether the body carries a `segments` array.
// Until the lane grows one, every segment request degrades to a single UNKNOWN
// speaker with a reason — never an invented label, never a failed request.

// The sentinel lives in the attribution module (one definition for both the
// transcription route and the capture store); re-exported here so this route's
// public shape does not move.
export { SPEAKER_UNKNOWN };
export const SEGMENTS_RESPONSE_FORMAT = "verbose_json";
export const SEGMENT_DEGRADED_NO_DIARIZATION = "upstream_no_diarization";
export const SEGMENT_DEGRADED_MALFORMED = "upstream_malformed_segments";
const SEGMENT_REQUEST_FIELD = "diarize";

// Opt-in from a multipart text field (folder captures) or the query string
// (ad-hoc probes). Absent/blank/anything unrecognised = today's behaviour.
export function wantsSegments(req) {
  const raw = req?.body?.[SEGMENT_REQUEST_FIELD] ?? req?.query?.[SEGMENT_REQUEST_FIELD];
  const v = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// OpenAI `verbose_json` gives offsets in seconds; our shape is milliseconds.
// Both spellings are read so a 词元-side dialect needs no second code path.
function offsetMs(item, msKey, secKey) {
  const ms = item?.[msKey];
  if (typeof ms === "number" && Number.isFinite(ms)) return Math.round(ms);
  const sec = item?.[secKey];
  if (typeof sec === "number" && Number.isFinite(sec)) return Math.round(sec * 1000);
  return null;
}

// The speaker is an upstream identifier (cluster index/name), never a person.
// A non-finite/missing one reads as UNKNOWN — the truthful value, not a label.
function speakerLabel(value) {
  if (typeof value === "string") return value.trim().slice(0, 64) || SPEAKER_UNKNOWN;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return SPEAKER_UNKNOWN;
}

function payloadDurationMs(payload) {
  const d = payload?.duration;
  if (typeof d === "number" && Number.isFinite(d) && d >= 0) return Math.round(d * 1000);
  return 0;
}

// Any upstream dialect → the ONE platform shape
// `{ segments: [{ startMs, endMs, speaker, text }], degraded?: { reason } }`.
// Nothing upstream-specific survives (no ids, tokens, logprobs, `start`/`end`).
//
// Only SHAPE is judged here. Reconciling segment text against the whole text is
// the merge layer's job (task 3.2) — doing it here would drop a whole recording
// over a punctuation difference.
export function normalizeSegments(payload, text) {
  const whole = (reason) => ({
    segments: [{ startMs: 0, endMs: payloadDurationMs(payload), speaker: SPEAKER_UNKNOWN, text }],
    degraded: { reason },
  });
  const raw = payload?.segments;
  if (!Array.isArray(raw) || raw.length === 0) return whole(SEGMENT_DEGRADED_NO_DIARIZATION);
  const segments = [];
  let prevEnd = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return whole(SEGMENT_DEGRADED_MALFORMED);
    const startMs = offsetMs(item, "startMs", "start");
    const endMs = offsetMs(item, "endMs", "end");
    if (startMs === null || endMs === null) return whole(SEGMENT_DEGRADED_MALFORMED);
    // Negative, inverted or overlapping-start offsets mean the offsets do not
    // describe one ordered line — refuse rather than stitch a broken document.
    if (startMs < 0 || endMs < startMs || startMs < prevEnd) return whole(SEGMENT_DEGRADED_MALFORMED);
    const segmentText = typeof item.text === "string" ? item.text.trim() : "";
    if (!segmentText) return whole(SEGMENT_DEGRADED_MALFORMED);
    segments.push({
      startMs,
      endMs,
      speaker: speakerLabel(item.speaker ?? item.speaker_id ?? item.speakerId),
      text: segmentText,
    });
    prevEnd = endMs;
  }
  return { segments };
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerVoiceRoutes(ctx) {
  const { app } = ctx;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  // Readable by every signed-in user: the composer decides from this whether
  // to render voice entries at all. `keySource` tells the UI whose account
  // bills ("your 词元 account" vs the deployment) — never the key itself.
  app.get("/api/voice/status", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    const config = resolveVoiceConfig();
    const { key, source } = resolveVoiceKey(ctx, req);
    const available = config.enabled && Boolean(key);
    res.json({
      available,
      reason: !config.enabled ? "disabled" : !key ? "no_key" : null,
      keySource: available ? source : null,
      config,
    });
  });

  // Admin write (open when auth is off — the machine owner). Merges onto the
  // RESOLVED config and stores the whole block, so env-seeded values are kept
  // when an admin only touches one field.
  app.put("/api/config/voice", (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser?.(req.user)) {
      return res.status(403).json({ error: "Admin group required" });
    }
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const r = validateVoiceConfig(req.body ?? {}, resolveVoiceConfig());
    if (!r.ok) return res.status(400).json({ error: r.error });
    db.setDeploymentConfig("voice", JSON.stringify(r.normalized));
    res.json({ config: r.normalized });
  });

  app.post("/api/voice/transcriptions", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    upload.single("file")(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "音频超过 25 MB 上限", code: "too_large" });
        return res.status(400).json({ error: "invalid multipart upload" });
      }
      if (!req.file?.buffer?.length) return res.status(400).json({ error: "field `file` is required (multipart/form-data)" });
      const config = resolveVoiceConfig();
      const keyInfo = resolveVoiceKey(ctx, req);
      if (!keyInfo.key) return res.status(503).json({ error: "语音服务未配置凭据", code: "voice_not_configured" });

      // Opt-in only: an absent switch keeps the previous body byte for byte
      // (task 2.1). The call itself goes through `transcribeBuffer` so this
      // lane and the capture lane cannot grow two error vocabularies (1.2/D10).
      const wantSegments = wantsSegments(req);
      const out = await transcribeBuffer({
        buffer: req.file.buffer,
        mime: req.file.mimetype,
        filename: req.file.originalname,
        config,
        keyInfo,
        ctx,
        wantSegments,
      });
      if (!out.ok) return res.status(out.status).json(out.body);
      if (!wantSegments) return res.json({ text: out.text, keySource: out.keySource });
      return res.json({
        text: out.text,
        segments: out.segments,
        ...(out.degraded ? { degraded: out.degraded } : {}),
        keySource: out.keySource,
      });
    });
  });

  app.post("/api/voice/speech", async (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    const input = typeof req.body?.input === "string" ? req.body.input.trim() : "";
    if (!input) return res.status(400).json({ error: "field `input` is required and must be a non-empty string" });
    const config = resolveVoiceConfig();
    if (!config.enabled) return res.status(503).json({ error: "语音功能已停用", code: "voice_disabled" });
    const keyInfo = resolveVoiceKey(ctx, req);
    if (!keyInfo.key) return res.status(503).json({ error: "语音服务未配置凭据", code: "voice_not_configured" });

    const truncated = input.length > TTS_MAX_INPUT_CHARS;
    const format = config.ttsFormat || VOICE_DEFAULTS.ttsFormat;
    const body = { input: truncated ? input.slice(0, TTS_MAX_INPUT_CHARS) : input, response_format: format };
    if (config.ttsModel) body.model = config.ttsModel;
    if (config.ttsVoice) body.voice = config.ttsVoice;

    let upstream;
    try {
      upstream = await forward(
        `${apiBase()}/v1/audio/speech`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${keyInfo.key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        TTS_TIMEOUT_MS,
      );
    } catch (e) {
      const f = failUnreachableResult("speech", e);
      return res.status(f.status).json(f.body);
    }
    if (!upstream.ok) {
      const f = await failUpstreamResult(ctx, upstream, keyInfo, "speech");
      return res.status(f.status).json(f.body);
    }
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("content-type", upstream.headers.get("content-type") || TTS_MIME[format] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-voice-key-source", keyInfo.source);
    if (truncated) res.setHeader("x-voice-truncated", "1");
    res.send(audio);
  });

  // ── captures: long recordings in slices ───────────────────────────────────
  //
  // A capture session is the answer to "this meeting is 55 minutes long": the
  // composer lane's ONE ≤25MB blob cannot carry it, and waiting for the whole
  // thing before any text appears is not a session anyone would use. The rules
  // that matter are in voice-capture.js; these routes are the transport.

  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CAPTURE_DEFAULTS.chunkMaxBytes },
  });

  // The transcription bill is expressed in minutes, but the budget has a USD
  // ceiling too. This is the conversion, and it is deliberately a knob: the
  // real price depends on the upstream the account is bound to.
  const usdPerMinute = () => {
    const v = Number(process.env.VOICE_ASR_USD_PER_MINUTE);
    return Number.isFinite(v) && v > 0 ? v : 0.006;
  };

  const captureOwner = (req) => identity(req)?.email || ctx.cellUserEmail || "local-owner";

  // Feature-owned table, ensured where it is used (same contract as the team
  // approval queue): idempotent CREATE IF NOT EXISTS, no boot ordering to get
  // wrong, and a failed ensure surfaces as a 500 instead of a silent empty list.
  const captureStore = () => {
    const handle = db.getDb();
    ensureVoiceCaptureTables(handle);
    return handle;
  };

  // Minutes of audio ACTUALLY transcribed (attempts > 0), recomputed from the
  // chunk rows rather than accumulated: an idempotent retry then cannot charge
  // twice, and a replayed request cannot inflate the bill.
  const usageOf = (handle, captureId) => {
    const rows = handle
      .prepare(
        "SELECT seq, start_ms, duration_ms, bytes FROM voice_capture_chunks WHERE capture_id = ? AND attempts > 0 ORDER BY seq",
      )
      .all(captureId);
    const minutes = durationOfChunks(rows) / 60_000;
    const usd = minutes * usdPerMinute();
    handle.prepare("UPDATE voice_captures SET minutes_used = ?, usd_used = ? WHERE id = ?").run(minutes, usd, captureId);
    return { minutes, usd };
  };

  const budgetReport = (capture, used) => ({
    minutes: used.minutes,
    minutesLimit: capture.budget.minutes,
    usd: used.usd,
    usdLimit: capture.budget.usd,
    resetsAt: null,
  });

  const captureRefusal = (res, r, status = 409) => res.status(status).json({ error: r.code, code: r.code, ...(r.detail ? { detail: r.detail } : {}) });

  // List. Read-only apart from the retention sweep: an expired recording must
  // stop accepting slices even when nobody runs the sweeper, and a list read is
  // the one moment a client is guaranteed to look.
  app.get("/api/voice/captures", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const handle = captureStore();
    const now = Date.now();
    try {
      sweepCaptures(handle, { now });
    } catch (e) {
      // A failed sweep must not take the list down: the read-time expiry fact in
      // getCapture() already protects correctness.
      console.warn(`[voice] capture sweep failed: ${e?.message || e}`);
    }
    res.json({ captures: listCaptures(handle, { owner: captureOwner(req), now }) });
  });

  app.post("/api/voice/captures", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    // Same two refusals as the composer lane, BEFORE any row exists (task 1.4:
    // a disabled lane must not leave half a capture behind).
    const nope = voiceUnavailable(resolveVoiceConfig(), resolveVoiceKey(ctx, req));
    if (nope) return res.status(nope.status).json(nope.body);

    const body = req.body ?? {};
    const options = {};
    const num = (v, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    if (num(body.ttlMs, 60_000, 7 * 24 * 60 * 60 * 1000) !== undefined) options.ttlMs = Number(body.ttlMs);
    if (num(body.minutesBudget, 1, 10_000) !== undefined) options.minutesBudget = Number(body.minutesBudget);
    if (num(body.usdBudget, 0, 10_000) !== undefined) options.usdBudget = Number(body.usdBudget);
    if (num(body.retainAudioMs, 0, 7 * 24 * 60 * 60 * 1000) !== undefined) options.retainAudioMs = Number(body.retainAudioMs);

    const capture = createCapture(captureStore(), {
      owner: captureOwner(req),
      cellId: ctx.cellId || ctx.cellUserEmail || "local",
      title: typeof body.title === "string" ? body.title : "",
      // 'session' = this person recorded alone on their own device. Default
      // 'shared': a room microphone must never be attributed to its owner.
      speakerMode: body.speakerMode === "session" ? "session" : "shared",
      // Which meeting this stream belongs to (add-meeting-capture). Optional and
      // unvalidated here on purpose: the meeting lives in the gateway's room db,
      // and the machine face refuses a stream whose meeting is not open in that
      // room — so the check happens where the meeting is, not where the audio is.
      meetingId: typeof body.meetingId === "string" && body.meetingId.trim()
        ? body.meetingId.trim().slice(0, 64)
        : null,
      options,
    });
    res.status(201).json({ capture });
  });

  // Chunk upload IS the transcription request: a slice is stored, reserved, sent
  // upstream and settled inside this one call. That is what keeps a failure
  // local — there is no batch to roll back and no queue to poison.
  app.post("/api/voice/captures/:id/chunks", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    chunkUpload.single("file")(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            error: `单个分片超过 ${Math.round(CAPTURE_DEFAULTS.chunkMaxBytes / 1024 / 1024)} MB 上限`,
            code: "chunk_too_large",
          });
        }
        return res.status(400).json({ error: "invalid multipart upload", code: "bad_upload" });
      }

      const handle = captureStore();
      const owner = captureOwner(req);
      const now = Date.now();
      const capture = getCapture(handle, { id: req.params.id, owner, now });
      // Not-yours and not-there are the same answer: an id probe must not
      // distinguish "exists but private" from "does not exist".
      if (!capture) return res.status(404).json({ error: "采集不存在", code: "not_found" });
      if (capture.status !== "recording") {
        return res.status(409).json({ error: "采集已结束，停止接收分片", code: "capture_not_recording", status: capture.status });
      }

      const seq = Number(req.body?.seq);
      const startMs = Number(req.body?.start_ms ?? req.body?.startMs);
      if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: "`seq` must be a non-negative integer", code: "bad_seq" });
      if (!Number.isFinite(startMs) || startMs < 0) {
        return res.status(400).json({ error: "`start_ms` must be a non-negative number", code: "bad_start_ms" });
      }
      const durationField = req.body?.duration_ms ?? req.body?.durationMs;
      const durationMs = durationField === undefined || durationField === "" ? null : Number(durationField);
      if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 0)) {
        return res.status(400).json({ error: "`duration_ms` must be a non-negative number", code: "bad_duration_ms" });
      }

      const existing = getChunk(handle, { captureId: capture.id, seq });
      let audio = req.file?.buffer ?? null;
      let mime = req.file?.mimetype ?? null;

      if (existing) {
        // Idempotent replay (task 2.1): a slice already transcribed answers with
        // its stored state — no second upstream call, no second charge, and the
        // text cannot change under a client that retried because a response was
        // lost.
        if (existing.status === "done") {
          return res.json({
            chunk: existing,
            duplicate: true,
            budget: budgetReport(capture, { minutes: capture.used.minutes, usd: capture.used.usd }),
          });
        }
        if (existing.status === "transcribing") {
          return res.status(409).json({ error: "分片正在转写中", code: "chunk_busy", chunk: existing });
        }
        // pending | failed → this call is the retry. The stored audio is the
        // authority (a failure keeps it), so a retry needs no re-upload; the
        // upload is only used if the stored slice somehow lost its audio.
        if (existing.hasAudio) {
          const row = handle.prepare("SELECT audio, mime FROM voice_capture_chunks WHERE capture_id = ? AND seq = ?").get(capture.id, seq);
          audio = row?.audio ?? audio;
          mime = row?.mime ?? mime;
        }
        if (!audio?.length) {
          return res.status(409).json({ error: "分片音频已清理，请重新上传该片", code: "chunk_audio_gone", chunk: existing });
        }
      } else {
        if (!audio?.length) return res.status(400).json({ error: "field `file` is required (multipart/form-data)", code: "missing_audio" });
        const timeline = checkTimeline(handle, { captureId: capture.id, seq, startMs });
        if (!timeline.ok) return captureRefusal(res, timeline);
        const inserted = insertChunk(handle, { captureId: capture.id, seq, startMs, durationMs, buffer: audio, mime, now });
        // Storage, not this route, is the idempotency anchor: a lost race lands
        // here as chunk_exists and is read back below as a duplicate.
        if (!inserted.ok && inserted.code !== "chunk_exists") return captureRefusal(res, inserted);
      }

      // Budget gates (task 4.1): at the ceiling we still STORE the slice — the
      // audio is the user's and dropping it would destroy data — but we do not
      // spend more. The response says which gate stopped and how far we got.
      const current = getCapture(handle, { id: capture.id, owner, now });
      const gate = budgetGate(current);
      if (gate) {
        if (!existing) {
          const stored = getChunk(handle, { captureId: capture.id, seq });
          return res.status(202).json({
            chunk: stored,
            stopped: gate,
            budget: budgetReport(current, current.used),
          });
        }
        return res.status(202).json({ chunk: existing, stopped: gate, budget: budgetReport(current, current.used) });
      }

      // Same gate as the composer (fix-voice-transcription-container 4.2), but
      // placed BEFORE beginChunk on purpose: a container the lane always refuses
      // must not consume a retry attempt — retrying the same bytes cannot ever
      // succeed, and spending attempts would turn "wrong format" into "gave up".
      const blocked = audio?.length ? unsupportedContainerResult(audio) : null;
      if (blocked) {
        finishChunk(handle, { captureId: capture.id, seq, ok: false, errorCode: blocked.body.code, now });
        const used = usageOf(handle, capture.id);
        return res.status(blocked.status).json({
          ...blocked.body,
          chunk: getChunk(handle, { captureId: capture.id, seq }),
          retryable: false,
          budget: budgetReport(current, used),
        });
      }

      const begun = beginChunk(handle, { captureId: capture.id, seq, now });
      if (!begun.ok) {
        // Transcribed between the read and here, busy, or out of retries.
        const latest = getChunk(handle, { captureId: capture.id, seq });
        if (latest?.status === "done") return res.json({ chunk: latest, duplicate: true });
        if (begun.code === "chunk_busy") {
          return res.status(409).json({ error: "分片正在转写中", code: "chunk_busy", chunk: latest });
        }
        return res.status(409).json({
          error: `分片重试次数已达上限（${CAPTURE_DEFAULTS.maxAttempts}）`,
          code: "chunk_retry_exhausted",
          chunk: latest,
        });
      }

      const config = resolveVoiceConfig();
      const keyInfo = resolveVoiceKey(ctx, req);
      // The capture lane asks for segments on the same opt-in switch as the
      // composer lane (D1/D10). Off by default and byte-identical when off — but
      // when it IS on, the segments have to reach storage here or the route has
      // computed `wantSegments` for nobody, which is the exact shape of the bug
      // this change exists to fix.
      const wantSegments = wantsSegments(req);
      const out = await transcribeBuffer({
        buffer: audio,
        mime,
        filename: `capture-${capture.id}-${seq}`,
        config,
        keyInfo,
        ctx,
        wantSegments,
      });

      if (!out.ok) {
        // Failure is isolated to this slice (task 2.3): the other 19 keep their
        // text, and this one keeps its audio so the retry is one request.
        finishChunk(handle, { captureId: capture.id, seq, ok: false, errorCode: out.body?.code ?? "upstream_error", now });
        const used = usageOf(handle, capture.id);
        return res.status(out.status).json({
          ...out.body,
          chunk: getChunk(handle, { captureId: capture.id, seq }),
          retryable: (getChunk(handle, { captureId: capture.id, seq })?.attempts ?? 0) < CAPTURE_DEFAULTS.maxAttempts,
          budget: budgetReport(current, used),
        });
      }

      finishChunk(handle, { captureId: capture.id, seq, ok: true, text: out.text, segments: out.segments ?? null, now });
      const used = usageOf(handle, capture.id);
      const after = getCapture(handle, { id: capture.id, owner, now });
      res.json({
        chunk: getChunk(handle, { captureId: capture.id, seq }),
        keySource: out.keySource,
        budget: budgetReport(after, used),
        // The gate may have closed on THIS call; saying so here saves the client
        // one wasted upload before it learns the budget is spent.
        ...(budgetGate(after) ? { stopped: budgetGate(after) } : {}),
      });
    });
  });

  app.get("/api/voice/captures/:id", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const handle = captureStore();
    const capture = getCapture(handle, { id: req.params.id, owner: captureOwner(req), now: Date.now() });
    // Abandoned reads as missing: its audio and text are gone, so returning a
    // tombstone would only invite a client to render an empty meeting.
    if (!capture || capture.status === "abandoned") {
      return res.status(404).json({ error: "采集不存在", code: "not_found" });
    }
    res.json({ capture, chunks: listChunks(handle, { captureId: capture.id }) });
  });

  app.post("/api/voice/captures/:id/finish", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const handle = captureStore();
    const out = finishCapture(handle, { id: req.params.id, owner: captureOwner(req), now: Date.now() });
    if (!out.ok) return res.status(404).json({ error: "采集不存在", code: out.code });

    // Attribution is derived once, when the text is complete — a half-recorded
    // meeting has nothing to attribute yet. Anonymous slices queue a "who said
    // this?" card in the existing todo surface; nothing is dispatched on a guess.
    let attribution = null;
    try {
      const rows = deriveCapture(handle, out.capture);
      syncPendingAttribution(ctx, { capture: out.capture, rows });
      attribution = { rows: rows.length, pending: rows.filter((r) => r.certainty === "anonymous").length };
    } catch (e) {
      // A failed derivation must not cost the user their transcript.
      console.warn(`[voice] attribution derivation failed: ${e?.message || e}`);
    }
    res.json({
      capture: out.capture,
      segments: out.segments ?? [],
      already: Boolean(out.already),
      attribution,
    });
  });

  // One human correction, which leaves the machine's own merge readable
  // (task 3.4). Editing is not an overwrite: the record of what was heard and
  // the record of what was meant are different facts.
  app.post("/api/voice/captures/:id/correct", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const text = typeof req.body?.text === "string" ? req.body.text : null;
    if (text === null) return res.status(400).json({ error: "field `text` is required", code: "bad_text" });
    const handle = captureStore();
    const out = correctCapture(handle, { id: req.params.id, owner: captureOwner(req), text, now: Date.now() });
    if (!out.ok) {
      return res.status(409).json({
        error: out.code === "already_corrected" ? "该采集已订正过一次" : "采集尚未结束，无法订正",
        code: out.code,
      });
    }
    res.json({ capture: out.capture });
  });

  app.post("/api/voice/captures/:id/abandon", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const handle = captureStore();
    const out = abandonCapture(handle, { id: req.params.id, owner: captureOwner(req), now: Date.now() });
    if (!out.ok) return res.status(404).json({ error: "采集不存在", code: out.code });
    // Attribution dies with the audio and text — no orphan clusters (7.3).
    purgeAttributions(handle, { captureId: req.params.id });
    res.json({ ok: true });
  });

  // Into a room (5.2/5.3, design D7). The capture lands as ONE `system` row
  // carrying `meta.source = "capture"`: it is a record of a meeting, not a
  // person speaking, and pretending otherwise would poison member attribution
  // and — worse — wake every agent in the room with a transcript as if it were
  // a prompt. A direct mirror write dispatches no turn, so no quota is touched.
  //
  // Confirmation is required and explicit (`confirm: true`), because this is the
  // one step that publishes a recording of a private conversation into a room.
  app.post("/api/voice/captures/:id/room", (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    if (req.body?.confirm !== true) {
      return res.status(409).json({ error: "送入房间需要一次确认", code: "confirmation_required" });
    }
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    if (!sessionId) return res.status(400).json({ error: "field `sessionId` is required", code: "bad_session" });

    const handle = captureStore();
    const owner = captureOwner(req);
    const capture = getCapture(handle, { id: req.params.id, owner, now: Date.now() });
    if (!capture || capture.status === "abandoned") {
      return res.status(404).json({ error: "采集不存在", code: "not_found" });
    }
    // Idempotent per (capture, room): a second click must not add a second copy
    // of the same meeting to the transcript.
    if (capture.roomId === sessionId) {
      return res.json({ ok: true, sessionId, alreadyInRoom: true });
    }
    if (capture.status !== "finished") {
      return res.status(409).json({ error: "采集尚未结束，没有可送入的文本", code: "not_finished" });
    }
    const text = String(capture.mergedText ?? "").trim();
    if (!text) return res.status(409).json({ error: "采集没有文本", code: "empty_capture" });

    const access = ctx.chatHistory?.accessSession?.(req.user, sessionId, {
      authEnabled: ctx.authEnabled,
      isAdmin: ctx.isAdminUser?.(req.user),
    });
    if (access && !access.ok) {
      return res
        .status(access.reason === "forbidden" ? 403 : 404)
        .json({ error: access.reason === "forbidden" ? "Session owner required" : "session not found", code: access.reason });
    }
    if (typeof ctx.chatHistory?.recordMessage !== "function") {
      return res.status(503).json({ error: "对话记录不可用", code: "chat_history_unavailable" });
    }

    // One message per speaker (D9). The split is not cosmetic: the room decides
    // its route per message, so a single row holding two voices could only be
    // routed to one of them — and would claim both.
    const { messages } = captureRoomMessages({ capture, view: mergedView(handle, capture) });
    if (!messages.length) return res.status(409).json({ error: "采集没有文本", code: "empty_capture" });
    for (const m of messages) {
      ctx.chatHistory.recordMessage(sessionId, "system", m.content, [{ type: "event", meta: m.meta }], owner);
    }
    handle.prepare("UPDATE voice_captures SET room_id = ? WHERE id = ?").run(sessionId, capture.id);
    res.json({ ok: true, sessionId, messages: messages.length });
  });

  // ── Into a VOICE room (add-speaker-attribution 5.2 + D9's transport) ──────
  // The capture store and the room store are two processes, so the per-speaker
  // messages travel to the gateway over its machine face. This route owns the
  // split; the gateway owns the room write and the route decision.
  app.post("/api/voice/captures/:id/zhiyu-room", async (req, res) => {
    if (!requireUser(req, res, ctx)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    if (req.body?.confirm !== true) {
      return res.status(409).json({ error: "送入房间需要一次确认", code: "confirmation_required" });
    }
    const roomId = typeof req.body?.roomId === "string" ? req.body.roomId.trim() : "";
    if (!/^zy_[0-9a-f]+$/.test(roomId)) {
      return res.status(400).json({ error: "field `roomId` must be a zhiyu room id", code: "bad_room" });
    }

    const handle = captureStore();
    const owner = captureOwner(req);
    const capture = getCapture(handle, { id: req.params.id, owner, now: Date.now() });
    if (!capture || capture.status === "abandoned") {
      return res.status(404).json({ error: "采集不存在", code: "not_found" });
    }
    if (capture.roomId === roomId) return res.json({ ok: true, roomId, alreadyInRoom: true });
    if (capture.status !== "finished") {
      return res.status(409).json({ error: "采集尚未结束，没有可送入的文本", code: "not_finished" });
    }
    const { messages } = captureRoomMessages({ capture, view: mergedView(handle, capture) });
    if (!messages.length) return res.status(409).json({ error: "采集没有文本", code: "empty_capture" });

    const gatewayBase = () =>
      (process.env.GATEWAY_INTERNAL_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
    let out;
    try {
      const r = await fetchWithTimeout(`${gatewayBase()}/api/zhiyu/capture-ingest/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [GATEWAY_SECRET_HEADER]: process.env.CELL_GATEWAY_SECRET || "",
          "x-actor-email": owner,
        },
        body: JSON.stringify({
          captureId: capture.id,
          title: capture.title ?? null,
          // A meeting stream carries its meeting id so the gateway can check
          // that stream against the meeting it claims (see capture-ingest).
          ...(capture.meetingId ? { meetingId: capture.meetingId } : {}),
          messages: messages.map((m) => ({
            content: m.content,
            memberRef: m.meta.capture?.seatOwnerMemberId ?? m.meta.capture?.declaredMemberId ?? null,
            capture: m.meta.capture,
          })),
        }),
      });
      out = await r.json().catch(() => null);
      if (!r.ok) {
        return res.status(r.status === 404 ? 404 : 502).json({
          error: r.status === 403 ? "无权向该房间投递" : "房间暂不可用",
          code: out?.code ?? "gateway_refused",
        });
      }
    } catch (err) {
      return res.status(502).json({ error: `gateway unreachable: ${err.message}`, code: "gateway_unreachable" });
    }

    handle.prepare("UPDATE voice_captures SET room_id = ? WHERE id = ?").run(roomId, capture.id);
    res.json({ ok: true, roomId, messages: messages.length, delivered: out?.delivered ?? [] });
  });

  // Idempotent retention sweep (task 4.2). Exposed so an operator/cron can run
  // it on a schedule; the counts are the point — "expired 0, purgedAudio 0" is
  // the proof a second run is a no-op.
  app.post("/api/voice/captures/sweep", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const handle = captureStore();
    const counts = sweepCaptures(handle, { now: Date.now() });
    // Retention covers attribution, not only audio: an expired or abandoned
    // capture must not leave a readable record of who said what (7.3).
    for (const row of handle.prepare("SELECT id FROM voice_captures WHERE status IN ('expired','abandoned')").all()) {
      purgeAttributions(handle, { captureId: row.id });
    }
    res.json(counts);
  });

  // The attribution face lives beside its capture (5.x / 6.2).
  registerSpeakerAttributionRoutes(ctx);
}
