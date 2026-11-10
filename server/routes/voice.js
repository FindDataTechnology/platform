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
import * as db from "../../db.js";
import * as ciyuanAccount from "../../ciyuan-account-credentials.js";

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

async function failUpstream(ctx, res, upstream, keyInfo, lane) {
  const code = await upstreamCode(upstream);
  if (upstream.status === 401 || upstream.status === 403) {
    if (keyInfo.source === "user") {
      if (ciyuanAccount.markStale(keyInfo.email)) {
        ctx.broadcast?.({ type: STALE_EVENT });
        rewriteModelLane(ctx);
      }
      console.warn(`[voice] upstream ${upstream.status} on ${lane} with the user's 词元 key — binding marked stale`);
      return res.status(401).json({
        error: "词元账号凭据已失效，请重新连接",
        code: "credential_stale",
        connect: { panel: "ciyuan-account" },
      });
    }
    console.warn(`[voice] upstream ${upstream.status} on ${lane} with the deployment key${code ? ` (${code})` : ""}`);
    return res.status(502).json({ error: "语音服务拒绝了部署凭据", code: "upstream_unauthorized" });
  }
  console.warn(`[voice] upstream ${upstream.status} on ${lane}${code ? ` (${code})` : ""}`);
  return res.status(502).json({
    error: "语音服务暂不可用",
    code: "upstream_error",
    upstreamStatus: upstream.status,
    ...(code ? { upstreamCode: code } : {}),
  });
}

function failUnreachable(res, lane, err) {
  const aborted = err?.name === "AbortError";
  console.warn(`[voice] upstream ${aborted ? "timeout" : "unreachable"} on ${lane}: ${err?.message || err}`);
  return res.status(502).json({
    error: aborted ? "语音服务响应超时" : "语音服务不可达",
    code: aborted ? "upstream_timeout" : "upstream_unreachable",
  });
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
      if (!config.enabled) return res.status(503).json({ error: "语音功能已停用", code: "voice_disabled" });
      const keyInfo = resolveVoiceKey(ctx, req);
      if (!keyInfo.key) return res.status(503).json({ error: "语音服务未配置凭据", code: "voice_not_configured" });

      const form = new FormData();
      form.append(
        "file",
        new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" }),
        req.file.originalname || "audio",
      );
      if (config.asrModel) form.append("model", config.asrModel);
      form.append("response_format", "json");

      let upstream;
      try {
        upstream = await forward(
          `${apiBase()}/v1/audio/transcriptions`,
          { method: "POST", headers: { authorization: `Bearer ${keyInfo.key}` }, body: form },
          ASR_TIMEOUT_MS,
        );
      } catch (e) {
        return failUnreachable(res, "transcriptions", e);
      }
      if (!upstream.ok) return failUpstream(ctx, res, upstream, keyInfo, "transcriptions");
      let payload;
      try {
        payload = await upstream.json();
      } catch {
        return res.status(502).json({ error: "语音服务返回了无法解析的结果", code: "upstream_malformed" });
      }
      const text = typeof payload?.text === "string" ? payload.text : "";
      res.json({ text, keySource: keyInfo.source });
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
      return failUnreachable(res, "speech", e);
    }
    if (!upstream.ok) return failUpstream(ctx, res, upstream, keyInfo, "speech");
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("content-type", upstream.headers.get("content-type") || TTS_MIME[format] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-voice-key-source", keyInfo.source);
    if (truncated) res.setHeader("x-voice-truncated", "1");
    res.send(audio);
  });
}
