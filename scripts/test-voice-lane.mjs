// voice-lane (tasks 1.1 / 1.2): the /api/voice/* forwarders against a
// programmable fake 词元 audio lane, the three-level key resolution, the
// stale-on-401 contract, the voice config block (stored > env > defaults,
// admin write), and the "key never reaches a client or a log line" invariant.
//
//   node --test scripts/test-voice-lane.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-lane-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
const ENV_KEY = ["sk-env", "deployment-llm-seed-0000"].join("-");
process.env.LLM_API_KEY = ENV_KEY;
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;

// ── programmable fake 词元 audio lane ───────────────────────────────────────
const fake = { mode: { asr: "ok", tts: "ok" }, seen: [] };
const FAKE_MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61, 0x55)]);
const fakeServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const text = raw.toString("latin1");
    const rec = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      bytes: raw.length,
      hasModelField: /name="model"/.test(text),
      fileName: /filename="([^"]+)"/.exec(text)?.[1] ?? null,
      json: (() => { try { return JSON.parse(raw.toString("utf8")); } catch { return null; } })(),
    };
    fake.seen.push(rec);
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/v1/audio/transcriptions") {
      if (fake.mode.asr === "401") return json(401, { error: { code: "invalid_api_key", message: "bad key sk-shouldnotleak" } });
      if (fake.mode.asr === "502") return json(502, { error: { code: "lane_upstream_unavailable" } });
      if (fake.mode.asr === "hang") return;
      return json(200, { text: "假服务转写文本" });
    }
    if (req.url === "/v1/audio/speech") {
      if (fake.mode.tts === "401") return json(401, { error: { code: "invalid_api_key" } });
      if (fake.mode.tts === "502") return json(502, { error: { code: "lane_upstream_unavailable" } });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(FAKE_MP3);
    }
    json(404, { error: "nope" });
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const ca = await import("../ciyuan-account-credentials.js");
const voice = await import("../server/routes/voice.js");

const EMAIL = "owner@x.test";
const MINTED = `sk-minted-${"m".repeat(40)}`;
const AS_OWNER = { "x-forwarded-email": EMAIL, "x-forwarded-groups": "" };
const AS_ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

function request(app, method, p, { headers = {}, body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = httpRequest({
        host: "127.0.0.1", port, path: p, method,
        headers: {
          ...(payload && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}),
          ...(payload ? { "content-length": payload.length } : {}),
          ...headers,
        },
      }, (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(parts);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, buf, body: json }));
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

function multipart(fields, file) {
  const boundary = `----voice${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, 1)]);

function makeCtx(overrides = {}) {
  process.env.CELL_USER_EMAIL = EMAIL;
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: true,
    logtoAuth: null,
    broadcasts: [],
    ...overrides,
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  return ctx;
}

function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(" ")); };
  return Promise.resolve().then(fn).finally(() => { Object.assign(console, orig); }).then((r) => ({ r, lines }));
}

const asr = (ctx, headers = AS_OWNER, file = { name: "recording.webm", type: "audio/webm", data: WAV }) => {
  const m = multipart({}, file);
  return request(ctx.app, "POST", "/api/voice/transcriptions", { headers: { ...headers, ...m.headers }, body: m.body });
};
const tts = (ctx, input, headers = AS_OWNER) => request(ctx.app, "POST", "/api/voice/speech", { headers, body: { input } });

// ── config block ────────────────────────────────────────────────────────────

test("config: defaults → env seed → stored, each layer winning over the previous; bad layers degrade", async () => {
  assert.deepEqual(voice.resolveVoiceConfig(), { ...voice.VOICE_DEFAULTS });
  process.env.VOICE_CONFIG = JSON.stringify({ asrModel: "env-asr", ttsVoice: "env-voice" });
  assert.equal(voice.resolveVoiceConfig().asrModel, "env-asr");
  assert.equal(voice.resolveVoiceConfig().ttsFormat, "mp3", "unset fields keep defaults");
  db.setDeploymentConfig("voice", JSON.stringify({ ...voice.VOICE_DEFAULTS, asrModel: "stored-asr" }));
  assert.equal(voice.resolveVoiceConfig().asrModel, "stored-asr", "stored wins over env");
  const { lines } = await captureConsole(() => {
    db.setDeploymentConfig("voice", "{not json");
    assert.equal(voice.resolveVoiceConfig().asrModel, "env-asr", "bad stored JSON falls through to env");
    db.setDeploymentConfig("voice", JSON.stringify({ ttsFormat: "midi" }));
    assert.equal(voice.resolveVoiceConfig().asrModel, "env-asr", "invalid stored block falls through to env");
  });
  assert.ok(lines.some((l) => l.includes("[voice] stored config")), "degradation is logged");
  db.clearDeploymentConfig("voice");
  delete process.env.VOICE_CONFIG;
});

test("validateVoiceConfig: partial merge, blank resets, unknown key and bad format refused", () => {
  const base = { ...voice.VOICE_DEFAULTS, asrModel: "keep-me", ttsFormat: "wav" };
  const ok = voice.validateVoiceConfig({ ttsVoice: " alloy ", ttsFormat: "" }, base);
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.asrModel, "keep-me", "absent field keeps the base");
  assert.equal(ok.normalized.ttsVoice, "alloy", "trimmed");
  assert.equal(ok.normalized.ttsFormat, "mp3", "blank format resets to the default");
  assert.equal(voice.validateVoiceConfig({ enabled: "yes" }).ok, false);
  assert.equal(voice.validateVoiceConfig({ ttsFormat: "midi" }).ok, false);
  assert.equal(voice.validateVoiceConfig({ bogus: 1 }).ok, false);
  assert.equal(voice.validateVoiceConfig({ asrModel: "x".repeat(121) }).ok, false);
  assert.equal(voice.validateVoiceConfig([]).ok, false);
});

test("PUT /api/config/voice: admin-gated, validated, merges onto the resolved block", async () => {
  const ctx = makeCtx();
  const denied = await request(ctx.app, "PUT", "/api/config/voice", { headers: AS_OWNER, body: { enabled: false } });
  assert.equal(denied.status, 403);
  assert.equal(db.getDeploymentConfig("voice"), null, "nothing stored on a refused write");
  const bad = await request(ctx.app, "PUT", "/api/config/voice", { headers: AS_ADMIN, body: { ttsFormat: "midi" } });
  assert.equal(bad.status, 400);
  process.env.VOICE_CONFIG = JSON.stringify({ asrModel: "env-asr" });
  const ok = await request(ctx.app, "PUT", "/api/config/voice", { headers: AS_ADMIN, body: { ttsVoice: "alloy" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.ttsVoice, "alloy");
  assert.equal(ok.body.config.asrModel, "env-asr", "env-seeded field survives a one-field admin write");
  assert.equal(JSON.parse(db.getDeploymentConfig("voice")).ttsVoice, "alloy");
  delete process.env.VOICE_CONFIG;
  db.clearDeploymentConfig("voice");
});

// ── status ──────────────────────────────────────────────────────────────────

test("GET /api/voice/status: available/reason/keySource, never the key", async () => {
  const ctx = makeCtx();
  let r = await request(ctx.app, "GET", "/api/voice/status", { headers: AS_OWNER });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.available, r.body.reason, r.body.keySource], [true, null, "deployment"]);
  assert.ok(!JSON.stringify(r.body).includes("sk-"), "no key material in the status read");
  ca.store({ email: EMAIL, token: MINTED, keyId: 9, keyName: "yizuo-x", groupId: 3, ciyuanEmail: "u@findmail.com" });
  r = await request(ctx.app, "GET", "/api/voice/status", { headers: AS_OWNER });
  assert.equal(r.body.keySource, "user");
  assert.ok(!JSON.stringify(r.body).includes(MINTED));
  ca.disconnect(EMAIL);
  db.setDeploymentConfig("voice", JSON.stringify({ ...voice.VOICE_DEFAULTS, enabled: false }));
  r = await request(ctx.app, "GET", "/api/voice/status", { headers: AS_OWNER });
  assert.deepEqual([r.body.available, r.body.reason, r.body.keySource], [false, "disabled", null]);
  db.clearDeploymentConfig("voice");
  const anon = await request(ctx.app, "GET", "/api/voice/status");
  assert.equal(anon.status, 401, "auth on: identity required");
});

// ── key resolution on the forwarders ────────────────────────────────────────

test("① bound user: the upstream request carries the user's minted key; the file name and model pass through", async () => {
  const ctx = makeCtx();
  ca.store({ email: EMAIL, token: MINTED, keyId: 9, keyName: "yizuo-x", groupId: 3, ciyuanEmail: "u@findmail.com" });
  db.setDeploymentConfig("voice", JSON.stringify({ ...voice.VOICE_DEFAULTS, asrModel: "SenseVoiceSmall" }));
  fake.seen.length = 0;
  const { r, lines } = await captureConsole(() => asr(ctx));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { text: "假服务转写文本", keySource: "user" });
  const up = fake.seen.at(-1);
  assert.equal(up.url, "/v1/audio/transcriptions");
  assert.equal(up.auth, `Bearer ${MINTED}`);
  assert.equal(up.fileName, "recording.webm");
  assert.equal(up.hasModelField, true);
  assert.ok(up.contentType.startsWith("multipart/form-data"));
  assert.ok(!lines.some((l) => l.includes(MINTED) || l.includes(ENV_KEY)), "no key in any log line");
  db.clearDeploymentConfig("voice");
});

test("② unbound user falls back to the deployment key; blank asrModel sends no model field", async () => {
  const ctx = makeCtx();
  ca.disconnect(EMAIL);
  fake.seen.length = 0;
  const r = await asr(ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.keySource, "deployment");
  assert.equal(fake.seen.at(-1).auth, `Bearer ${ENV_KEY}`);
  assert.equal(fake.seen.at(-1).hasModelField, false);
});

test("③ no credential anywhere → 503 voice_not_configured with no upstream request", async () => {
  const ctx = makeCtx();
  ca.disconnect(EMAIL);
  const saved = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  fake.seen.length = 0;
  try {
    const r = await asr(ctx);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "voice_not_configured");
    const s = await tts(ctx, "hello");
    assert.equal(s.status, 503);
    assert.equal(fake.seen.length, 0, "upstream never called");
  } finally {
    process.env.LLM_API_KEY = saved;
  }
});

test("④ upstream 401 on the user's key: binding marked stale, stale event broadcast, 401 + connect pointer", async () => {
  const ctx = makeCtx();
  ca.store({ email: EMAIL, token: MINTED, keyId: 9, keyName: "yizuo-x", groupId: 3, ciyuanEmail: "u@findmail.com" });
  fake.mode.asr = "401";
  try {
    const { r, lines } = await captureConsole(() => asr(ctx));
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "credential_stale");
    assert.deepEqual(r.body.connect, { panel: "ciyuan-account" });
    assert.equal(ca.status(EMAIL).stale, true, "binding is stale");
    assert.deepEqual(ctx.broadcasts, [{ type: "line_credential_stale" }]);
    assert.ok(!JSON.stringify(r.body).includes("sk-"), "upstream body (which echoes a key) never relayed");
    assert.ok(!lines.some((l) => l.includes("sk-shouldnotleak")), "upstream body never logged");
    // Next call: stale binding reads as absent → deployment key, no second broadcast.
    fake.mode.asr = "ok";
    fake.seen.length = 0;
    const again = await asr(ctx);
    assert.equal(again.body.keySource, "deployment");
    assert.equal(fake.seen.at(-1).auth, `Bearer ${ENV_KEY}`);
    assert.equal(ctx.broadcasts.length, 1);
  } finally {
    fake.mode.asr = "ok";
    ca.disconnect(EMAIL);
  }
});

test("④b upstream 401 on the deployment key: 502, no binding touched", async () => {
  const ctx = makeCtx();
  ca.disconnect(EMAIL);
  fake.mode.tts = "401";
  try {
    const r = await tts(ctx, "hello");
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "upstream_unauthorized");
    assert.equal(ctx.broadcasts.length, 0);
  } finally {
    fake.mode.tts = "ok";
  }
});

test("⑤ upstream 5xx → 502 sanitized with the lane code; stale state untouched", async () => {
  const ctx = makeCtx();
  ca.store({ email: EMAIL, token: MINTED, keyId: 9, keyName: "yizuo-x", groupId: 3, ciyuanEmail: "u@findmail.com" });
  fake.mode.asr = "502";
  try {
    const r = await asr(ctx);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "upstream_error");
    assert.equal(r.body.upstreamCode, "lane_upstream_unavailable");
    assert.equal(ca.status(EMAIL).stale, false);
    assert.equal(ctx.broadcasts.length, 0);
  } finally {
    fake.mode.asr = "ok";
    ca.disconnect(EMAIL);
  }
});

test("⑨ oversize upload → 413 before any upstream request; missing file → 400", async () => {
  const ctx = makeCtx();
  fake.seen.length = 0;
  const big = await asr(ctx, AS_OWNER, { name: "big.wav", type: "audio/wav", data: Buffer.alloc(25 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  assert.equal(big.body.code, "too_large");
  const none = request(ctx.app, "POST", "/api/voice/transcriptions", {
    headers: { ...AS_OWNER, ...multipart({ model: "x" }).headers },
    body: multipart({ model: "x" }).body,
  });
  assert.equal((await none).status, 400);
  assert.equal(fake.seen.length, 0);
});

// ── speech ──────────────────────────────────────────────────────────────────

test("speech: forwards {input, response_format, model?, voice?} and relays the audio bytes + content type", async () => {
  const ctx = makeCtx();
  db.setDeploymentConfig("voice", JSON.stringify({ ...voice.VOICE_DEFAULTS, ttsModel: "tts-x", ttsVoice: "alloy", ttsFormat: "mp3" }));
  fake.seen.length = 0;
  const r = await tts(ctx, "你好世界");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "audio/mpeg");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-voice-key-source"], "deployment");
  assert.equal(r.headers["x-voice-truncated"], undefined);
  assert.ok(r.buf.equals(FAKE_MP3), "audio bytes relayed verbatim");
  const up = fake.seen.at(-1);
  assert.equal(up.url, "/v1/audio/speech");
  assert.deepEqual(up.json, { input: "你好世界", response_format: "mp3", model: "tts-x", voice: "alloy" });
  db.clearDeploymentConfig("voice");
  fake.seen.length = 0;
  await tts(ctx, "plain");
  assert.deepEqual(fake.seen.at(-1).json, { input: "plain", response_format: "mp3" }, "blank model/voice are omitted");
});

test("speech: over-long input is truncated for synthesis and flagged; empty input → 400; disabled → 503", async () => {
  const ctx = makeCtx();
  fake.seen.length = 0;
  const r = await tts(ctx, "字".repeat(voice.TTS_MAX_INPUT_CHARS + 50));
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-voice-truncated"], "1");
  assert.equal(fake.seen.at(-1).json.input.length, voice.TTS_MAX_INPUT_CHARS);
  assert.equal((await tts(ctx, "   ")).status, 400);
  db.setDeploymentConfig("voice", JSON.stringify({ ...voice.VOICE_DEFAULTS, enabled: false }));
  const off = await tts(ctx, "hello");
  assert.equal(off.status, 503);
  assert.equal(off.body.code, "voice_disabled");
  db.clearDeploymentConfig("voice");
});

test("unreachable upstream → 502 upstream_unreachable, no crash", async () => {
  const ctx = makeCtx();
  const saved = process.env.VOICE_API_BASE;
  process.env.VOICE_API_BASE = "http://127.0.0.1:9"; // nothing listens
  try {
    const r = await tts(ctx, "hello");
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "upstream_unreachable");
  } finally {
    process.env.VOICE_API_BASE = saved;
  }
});

test.after(() => {
  fakeServer.close();
});
