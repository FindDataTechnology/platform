// The transcription container gate (openspec: fix-voice-transcription-container,
// tasks 1.2 / 4.1 / 4.2).
//
// Why this file exists: the 词元 audio lane accepts only complete, seekable
// files, and each rejected-content 400 takes the shared audio account out of
// rotation for about a minute — measured 2026-11-15, the next WAV request
// answered 503 for ~60s. So the platform must never hand it a container we have
// measured it to refuse.
//
// Three things are pinned here, and each has a failure mode that looks fine:
//   1. the probe's table and the guard's table cannot drift apart (an entry
//      deleted from either side changes nothing visible until production);
//   2. the sniffing verdicts match the real containers (synthetic fixtures can
//      be written to agree with a wrong rule — the VERDICTS are asserted, and
//      task 1.1 additionally runs the sniffer over real ffmpeg/browser output);
//   3. a refused upload makes NO upstream request, and on the capture lane it
//      consumes no retry attempt (retrying the same bytes can never succeed).
//
//   node --test scripts/test-voice-container-gate.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-containers-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
process.env.LLM_API_KEY = ["sk-container", "seed-0000"].join("-");
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;

// ── samples shaped like the real thing ──────────────────────────────────────
// Each is a REAL container header followed by filler; the sniffer only reads
// leading bytes and the box chain, which is exactly how it will run in
// production (it must not scan 25 MB of payload).
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt ")]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(24, 0)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(24, 0)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24, 0)]);

function box(type, body = Buffer.alloc(0)) {
  const size = 8 + body.length;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, 4, "latin1");
  return Buffer.concat([head, body]);
}
const FTYP = box("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(8, 0)]));
// A finished file: ftyp → mdat → moov (no fragmentation markers).
const MP4_FINAL = Buffer.concat([FTYP, box("mdat", Buffer.alloc(16, 0)), box("moov", Buffer.from("mvhd"))]);
// What MediaRecorder streams: ftyp → moov(mvex) → moof → mdat.
const MP4_FRAG = Buffer.concat([FTYP, box("moov", Buffer.from("mvex")), box("moof"), box("mdat", Buffer.alloc(8))]);

// ── fake 词元 lane: counts EVERY upstream request ───────────────────────────
const fake = { calls: 0 };
const fakeServer = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    fake.calls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "转写成功" }));
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;
after(() => fakeServer.close());

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const voice = await import("../server/routes/voice.js");
const containers = await import("../server/voice-containers.js");

// The probe table lives in `scripts/probe-transcription-containers.mjs`, which
// `make-public-snapshot.mjs` EXCLUDES (个人推断的内部探针：它会往真实上游打请求)。
// 于是公开快照里这一 import 直接 MODULE_NOT_FOUND，整个文件连带那 6 条**不依赖探针表**的
// 用例一起死——2026-11-16 由 `test-public-snapshot-test-parity.mjs` 点名。
// 缺表 ⇒ 依赖它的三条判不出（带原因 skip），其余照跑。
const NO_PROBE_TABLE = fs.existsSync(path.join(import.meta.dirname ?? ".", "probe-transcription-containers.mjs"))
  ? false
  : "probe-transcription-containers.mjs 不在本树（被快照排除的内部探针）——夹具缺失，判不出，不是通过";
const PROBE_CASES = NO_PROBE_TABLE ? [] : (await import("./probe-transcription-containers.mjs")).PROBE_CASES;

const EMAIL = "owner@x.test";
const AS_OWNER = { "x-forwarded-email": EMAIL, "x-forwarded-groups": "" };

function request(app, method, p, { headers = {}, body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: p,
          method,
          headers: { "content-length": payload ? payload.length : 0, ...headers },
        },
        (res) => {
          const bufs = [];
          res.on("data", (c) => bufs.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(bufs).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch {
              json = null;
            }
            server.close(() => resolve({ status: res.statusCode, body: json, raw }));
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

function multipart(fields, file) {
  const boundary = `----cont${Date.now()}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    parts.push(file.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function makeCtx() {
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
    cellId: "cell-test",
    chatHistory: {
      accessSession: () => ({ ok: true, meta: { owner: EMAIL } }),
      recordMessage: () => {},
    },
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  return ctx;
}
const ctx = makeCtx();

// ── 1. the two tables cannot drift ──────────────────────────────────────────

test("probe 表里的拒收项与守卫集合逐项相同", { skip: NO_PROBE_TABLE }, () => {
  const probeRejected = new Set(PROBE_CASES.filter((c) => !c.accepted).map((c) => c.container));
  const guard = new Set(containers.REJECTED_AUDIO_CONTAINERS);
  assert.deepEqual([...probeRejected].sort(), [...guard].sort(), "探针与守卫的拒收集合不一致");

  // Named explicitly as well: deleting one from the guard is a silent
  // regression that only shows up as a minute of lane downtime in production.
  assert.deepEqual([...guard].sort(), ["mp4-fragmented", "ogg", "webm"]);
});

test("每个探针样本的嗅探结论与表一致", { skip: NO_PROBE_TABLE }, () => {
  for (const c of PROBE_CASES) {
    const verdict = containers.sniffAudioContainer(Uint8Array.from(c.build()));
    assert.equal(verdict, c.container, `${c.name} 被嗅探成 ${verdict}`);
    assert.equal(containers.isRejectedContainer(verdict), !c.accepted, `${c.name} 的收/不收与表相反`);
  }
});

test("真实形状的样本：成品 mp4 透传，分片 mp4 拒收", () => {
  assert.equal(containers.sniffAudioContainer(MP4_FINAL), "mp4");
  assert.equal(containers.isRejectedContainer("mp4"), false);
  assert.equal(containers.sniffAudioContainer(MP4_FRAG), "mp4-fragmented");
  assert.equal(containers.isRejectedContainer("mp4-fragmented"), true);
});

// ── 2. the gate itself ──────────────────────────────────────────────────────

test("unsupportedContainerResult：三种拒收形状给 415，其余给 null", () => {
  for (const [name, buf] of [["webm", WEBM], ["ogg", OGG], ["frag", MP4_FRAG]]) {
    const r = voice.unsupportedContainerResult(buf);
    assert.ok(r, `${name} 没有被守卫拦下`);
    assert.equal(r.ok, false);
    assert.equal(r.status, 415);
    assert.equal(r.body.code, "unsupported_audio_container");
    assert.match(r.body.error, /WAV \/ MP3 \/ M4A/, "415 必须点名可用的格式");
  }
  for (const [name, buf] of [["wav", WAV], ["mp3", MP3], ["final mp4", MP4_FINAL]]) {
    assert.equal(voice.unsupportedContainerResult(buf), null, `${name} 被误拦`);
  }
});

test("未知容器透传：闸只拦实测过的形状", () => {
  assert.equal(voice.unsupportedContainerResult(Buffer.from("SOMETHING ELSE ENTIRELY")), null);
});

// ── 3. the composer endpoint: 415 and NOT ONE upstream call ─────────────────

test("上传 webm 到 /api/voice/transcriptions ⇒ 415 且上游一次都没被调用", async () => {
  const before = fake.calls;
  const m = multipart({}, { name: "take.webm", type: "audio/webm", data: WEBM });
  const res = await request(ctx.app, "POST", "/api/voice/transcriptions", {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
  assert.equal(res.status, 415);
  assert.equal(res.body?.code, "unsupported_audio_container");
  assert.equal(fake.calls, before, "被拒收的上传不许打上游——每打一次别人的转写就断一分钟");
});

test("上传 wav 到 /api/voice/transcriptions ⇒ 透传到上游并回文本", async () => {
  const before = fake.calls;
  const m = multipart({}, { name: "take.wav", type: "audio/wav", data: WAV });
  const res = await request(ctx.app, "POST", "/api/voice/transcriptions", {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.text, "转写成功");
  assert.equal(fake.calls, before + 1);
});

// ── 4. the capture lane: refused ⇒ failed row, no attempt burned ────────────

test("采集切片是 webm ⇒ failed/unsupported_audio_container、不消耗 attempts、不打上游", async () => {
  const created = await request(ctx.app, "POST", "/api/voice/captures", { headers: AS_OWNER, body: { title: "容器闸" } });
  assert.equal(created.status, 201, `创建采集失败：${created.raw}`);
  const id = created.body.capture.id;

  const before = fake.calls;
  const m = multipart(
    { seq: 0, start_ms: 0, duration_ms: 5000 },
    { name: "capture-slice.webm", type: "audio/webm", data: WEBM },
  );
  const res = await request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
  assert.equal(res.status, 415);
  assert.equal(res.body?.code, "unsupported_audio_container");
  assert.equal(res.body?.retryable, false, "同一个 webm 重试永远不会成功");
  assert.equal(res.body?.chunk?.status, "failed");
  assert.equal(res.body?.chunk?.errorCode, "unsupported_audio_container");
  assert.equal(res.body?.chunk?.attempts, 0, "被拒收的容器不该消耗重试次数——那是「格式不对」不是「试过了」");
  assert.equal(fake.calls, before, "被拒收的切片不许打上游");
});

test("采集切片是 wav ⇒ 正常转写并落 done", async () => {
  const created = await request(ctx.app, "POST", "/api/voice/captures", { headers: AS_OWNER, body: { title: "容器闸 wav" } });
  assert.equal(created.status, 201);
  const id = created.body.capture.id;
  const m = multipart({ seq: 0, start_ms: 0, duration_ms: 5000 }, { name: "capture-slice.wav", type: "audio/wav", data: WAV });
  const res = await request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body?.chunk?.status, "done");
  assert.equal(res.body?.chunk?.text, "转写成功");
  assert.equal(res.body?.chunk?.mime, "audio/wav", "容器要如实记在切片上，排查时不该靠猜");
});
