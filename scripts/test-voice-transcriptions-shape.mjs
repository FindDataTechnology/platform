// add-speaker-attribution (tasks 2.1–2.4): the transcription response shape.
//
// Three things are asserted, in this order of importance:
//
//   1. The DEFAULT path is byte-identical to the pre-change contract. Not
//      "deep-equal" — the raw response body is compared to the literal string
//      the old code produced, so an added field or a reordered key goes red.
//   2. A segment request degrades honestly. The 词元 lane answers 200 with
//      `{text}` only (design appendix A), so the platform must return ONE
//      UNKNOWN-speaker segment plus a reason — never an invented label, never a
//      failed request, never a shortened text.
//   3. When segments DO arrive, the upstream shape does not leak through: the
//      only fields a caller can see are startMs / endMs / speaker / text, and
//      no field claims to know WHO a voice belongs to (no personId).
//
//   node --test scripts/test-voice-transcriptions-shape.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-shape-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
process.env.LLM_API_KEY = ["sk-env", "deployment-llm-seed-0000"].join("-");
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;
delete process.env.VOICE_API_BASE;

// ── programmable fake 词元 ASR (records the request, serves `fake.asrBody`) ──
const fake = { asrBody: { text: "假服务转写文本" }, seen: [] };
const fakeServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const text = raw.toString("latin1");
    fake.seen.push({
      url: req.url,
      bytes: raw.length,
      responseFormat: /name="response_format"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? null,
      diarizeField: /name="diarize"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? null,
    });
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/v1/audio/transcriptions") return json(200, fake.asrBody);
    json(404, { error: "nope" });
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const voice = await import("../server/routes/voice.js");

const EMAIL = "owner@x.test";
const AS_OWNER = { "x-forwarded-email": EMAIL, "x-forwarded-groups": "" };

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
          try { json = JSON.parse(buf.toString("utf8")); } catch { /* not json */ }
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, raw: buf.toString("utf8"), body: json }));
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
  const boundary = `----shape${Date.now()}${Math.floor(Math.random() * 1e6)}`;
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
const FILE = { name: "recording.webm", type: "audio/webm", data: WAV };

function makeApp() {
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
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  return ctx.app;
}
const app = makeApp();

function transcribe({ fields = {}, query = "" } = {}) {
  const m = multipart(fields, FILE);
  return request(app, "POST", `/api/voice/transcriptions${query}`, {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
}

// ── 2.1 default path: byte-identical ────────────────────────────────────────

test("不传开关：响应体与改造前逐字节相同，且上游仍收到 response_format=json", async () => {
  fake.asrBody = { text: "假服务转写文本" };
  fake.seen.length = 0;
  const res = await transcribe();
  assert.equal(res.status, 200);
  assert.equal(fake.seen.at(-1).responseFormat, "json", "默认不请求分段形状");
  assert.equal(fake.seen.at(-1).diarizeField, null, "默认不上送 diarize 字段");
  // The pre-change code emitted exactly this line. Comparing the raw body (not
  // a parsed object) is what makes "byte-identical" an assertion and not a hope.
  assert.equal(res.raw, '{"text":"假服务转写文本","keySource":"deployment"}');
});

// ── 2.3 degradation: no segments upstream ───────────────────────────────────

test("请求分段但上游只回整段文本 → 一段 UNKNOWN + upstream_no_diarization，文本完整", async () => {
  fake.asrBody = { text: "假服务转写文本" };
  fake.seen.length = 0;
  const res = await transcribe({ fields: { diarize: "1" } });
  assert.equal(res.status, 200, "缺标签绝不能让请求失败");
  assert.equal(fake.seen.at(-1).responseFormat, "verbose_json", "开关打开时才换形状");
  assert.deepEqual(Object.keys(res.body).sort(), ["degraded", "keySource", "segments", "text"]);
  assert.equal(res.body.text, "假服务转写文本");
  assert.deepEqual(res.body.degraded, { reason: "upstream_no_diarization" });
  assert.deepEqual(res.body.segments, [
    { startMs: 0, endMs: 0, speaker: "UNKNOWN", text: "假服务转写文本" },
  ]);
});

test("分段结构缺偏移 → upstream_malformed_segments 降级，仍返回 200 与完整文本", async () => {
  fake.asrBody = { text: "甲乙两句话", duration: 4.2, segments: [{ text: "甲", speaker: "A" }] };
  const res = await transcribe({ fields: { diarize: "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.degraded.reason, "upstream_malformed_segments");
  assert.equal(res.body.segments.length, 1);
  assert.equal(res.body.segments[0].speaker, "UNKNOWN");
  assert.equal(res.body.segments[0].text, "甲乙两句话");
  assert.equal(res.body.segments[0].endMs, 4200, "降级段仍保留已知时长");
});

test("分段乱序（起点早于上一段终点）→ 降级而不是硬拼", async () => {
  fake.asrBody = {
    text: "甲乙两句话",
    segments: [
      { start: 1.0, end: 2.0, text: "甲", speaker: "A" },
      { start: 1.5, end: 2.5, text: "乙", speaker: "B" },
    ],
  };
  const res = await transcribe({ fields: { diarize: "1" } });
  assert.equal(res.body.degraded.reason, "upstream_malformed_segments");
  assert.equal(res.body.segments.length, 1);
  assert.equal(res.body.segments[0].speaker, "UNKNOWN");
});

test("空段文本 / 非对象条目同样按 malformed 降级", async () => {
  for (const bad of [[{ start: 0, end: 1, text: "   ", speaker: "A" }], ["not-a-segment"]]) {
    fake.asrBody = { text: "整段文本", segments: bad };
    const res = await transcribe({ fields: { diarize: "1" } });
    assert.equal(res.body.degraded.reason, "upstream_malformed_segments", JSON.stringify(bad));
    assert.equal(res.body.text, "整段文本");
  }
});

// ── 2.2 normalization: only our shape, no upstream dialect ──────────────────

test("上游真给了分段 → 归一为唯一形状，上游专属字段一个都不剩", async () => {
  fake.asrBody = {
    text: "甲说了一句。乙也说了一句。",
    duration: 3.5,
    segments: [
      { id: 7, seek: 0, start: 0.25, end: 1.75, text: "甲说了一句。", speaker: "speaker_0", tokens: [1, 2], avg_logprob: -0.12 },
      { id: 8, seek: 1750, start: 1.75, end: 3.4, text: "乙也说了一句。", speaker: 1, tokens: [3], avg_logprob: -0.2 },
    ],
  };
  const res = await transcribe({ fields: { diarize: "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.degraded, undefined, "有合法分段时不标降级");
  assert.deepEqual(res.body.segments, [
    { startMs: 250, endMs: 1750, speaker: "speaker_0", text: "甲说了一句。" },
    { startMs: 1750, endMs: 3400, speaker: "1", text: "乙也说了一句。" },
  ]);
  for (const seg of res.body.segments) {
    assert.deepEqual(Object.keys(seg).sort(), ["endMs", "speaker", "startMs", "text"], "字段集合固定");
  }
  for (const leaked of ["avg_logprob", "tokens", "seek", '"id"', '"start"', '"end"']) {
    assert.ok(!res.raw.includes(leaked), `上游字段不得泄出：${leaked}`);
  }
});

// ── 2.4 no invention: speaker is a label, never an identity ─────────────────

test("转写响应里永不出现 personId 或任何「这段声音属于某人」的字段", async () => {
  const bodies = [
    { text: "只有文本" },
    { text: "有分段", segments: [{ start: 0, end: 1, text: "有分段", speaker: "A" }] },
  ];
  for (const asrBody of bodies) {
    fake.asrBody = asrBody;
    const res = await transcribe({ fields: { diarize: "1" } });
    assert.ok(!("personId" in res.body), "personId 只属于归属接口，不属于转写响应");
    assert.ok(!("identity" in res.body) && !("person" in res.body));
    assert.deepEqual(Object.keys(res.body).sort(), res.body.degraded
      ? ["degraded", "keySource", "segments", "text"]
      : ["keySource", "segments", "text"]);
  }
});

// ── the switch itself ───────────────────────────────────────────────────────

test("开关也接受查询串形式（?diarize=1），未知值一律视为关闭", async () => {
  fake.asrBody = { text: "假服务转写文本" };
  const on = await transcribe({ query: "?diarize=1" });
  assert.equal(fake.seen.at(-1).responseFormat, "verbose_json");
  assert.ok(Array.isArray(on.body.segments));
  for (const q of ["?diarize=0", "?diarize=", "?diarize=maybe", ""]) {
    const off = await transcribe({ query: q });
    assert.equal(fake.seen.at(-1).responseFormat, "json", `查询串 ${q || "(无)"} 应关闭分段`);
    assert.equal(off.raw, '{"text":"假服务转写文本","keySource":"deployment"}');
  }
});

// Without this the fake lane keeps the event loop alive and `node --test` hangs
// after every assertion has already passed (found the hard way).
test.after(() => {
  fakeServer.close();
});
