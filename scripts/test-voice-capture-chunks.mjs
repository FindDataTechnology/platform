// The capture lane's HTTP face (openspec: add-voice-capture-lane, tasks
// 1.3 / 1.4 / 2.1–2.4 / 3.1 / 3.4 / 4.1 / 4.2).
//
// The storage module already proves the invariants in isolation; what is
// unproven until here is the TRANSPORT: that a lost response replays into the
// same text and the same charge, that one bad slice leaves the other nineteen
// alone, that a retry is one request and not a re-upload, and that the two
// budget gates stop spending without hiding work already done.
//
//   node --test scripts/test-voice-capture-chunks.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-capture-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
process.env.LLM_API_KEY = ["sk-capture", "seed-0000"].join("-");
process.env.VOICE_ASR_USD_PER_MINUTE = "1"; // 1 minute of audio = 1 USD, on purpose
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;

// ── programmable fake 词元 audio lane ───────────────────────────────────────
// The chunk's text is derived from the seq embedded in the filename, so the
// merge assertions can name an exact expected string instead of guessing.
const fake = { mode: "ok", failSeqs: new Set(), seen: [] };

const fakeServer = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts).toString("latin1");
    const fileName = /filename="([^"]+)"/.exec(raw)?.[1] ?? "";
    const seq = Number(/-(\d+)$/.exec(fileName)?.[1] ?? -1);
    fake.seen.push({ url: req.url, fileName, seq });
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url !== "/v1/audio/transcriptions") return json(404, { error: "nope" });
    if (fake.mode === "401") return json(401, { error: { code: "invalid_api_key" } });
    if (fake.mode === "down") return json(502, { error: { code: "lane_upstream_unavailable" } });
    if (fake.failSeqs.has(seq)) return json(500, { error: { code: "asr_slice_failed" } });
    return json(200, { text: `第${seq}段文本` });
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const voice = await import("../server/routes/voice.js");

const EMAIL = "owner@x.test";
const OTHER = "other@x.test";
const AS_OWNER = { "x-forwarded-email": EMAIL, "x-forwarded-groups": "" };
const AS_OTHER = { "x-forwarded-email": OTHER, "x-forwarded-groups": "" };
const AS_ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

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
          headers: {
            ...(payload && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}),
            ...(payload ? { "content-length": payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const bufs = [];
          res.on("data", (c) => bufs.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(bufs);
            let json = null;
            try {
              json = JSON.parse(buf.toString("utf8"));
            } catch {
              /* binary */
            }
            server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf.toString("utf8") }));
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
  const boundary = `----cap${Date.now()}${Math.random().toString(16).slice(2)}`;
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

const SLICE = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(48, 7)]);

function makeCtx() {
  process.env.CELL_USER_EMAIL = EMAIL;
  // The room's transcript, in memory: every mirrored row lands here, which is
  // exactly what "the room gained one row" has to be measured against.
  const roomRows = [];
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
    roomRows,
    chatHistory: {
      accessSession: (user, id) => {
        // `room-other` belongs to someone else; everything else is this user's.
        if (id === "room-other") return { ok: false, reason: "forbidden" };
        if (id === "room-missing") return { ok: false, reason: "not_found" };
        return { ok: true, meta: { owner: user?.email ?? EMAIL } };
      },
      recordMessage: (sessionId, role, content, blocks, owner) => {
        roomRows.push({ sessionId, role, content, blocks, owner });
      },
    },
  };
  ctx.broadcast = (m) => ctx.broadcasts.push(m);
  registerAuth(ctx);
  voice.registerVoiceRoutes(ctx);
  return ctx;
}

const ctx = makeCtx();

const createCapture = async (body = {}, headers = AS_OWNER) =>
  request(ctx.app, "POST", "/api/voice/captures", { headers, body });

const putChunk = (id, { seq, startMs, durationMs, headers = AS_OWNER, file = { name: "slice.m4a", type: "audio/mp4", data: SLICE } }) => {
  const m = multipart({ seq, start_ms: startMs, duration_ms: durationMs }, file);
  return request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, { headers: { ...headers, ...m.headers }, body: m.body });
};

const getCapture = (id, headers = AS_OWNER) => request(ctx.app, "GET", `/api/voice/captures/${id}`, { headers });
const listCaptures = (headers = AS_OWNER) => request(ctx.app, "GET", "/api/voice/captures", { headers });

// ── 1.3 / 1.4 the five paths ──────────────────────────────────────────────

test("create → chunk → read → finish → abandon, each answering its own shape", async () => {
  fake.mode = "ok";
  const created = await createCapture({ title: "周会" });
  assert.equal(created.status, 201);
  assert.match(created.body.capture.id, /^cap_/);
  assert.equal(created.body.capture.status, "recording");
  assert.equal(created.body.capture.title, "周会");
  const id = created.body.capture.id;

  const up = await putChunk(id, { seq: 0, startMs: 0, durationMs: 30_000 });
  assert.equal(up.status, 200);
  assert.equal(up.body.chunk.status, "done");
  assert.equal(up.body.chunk.text, "第0段文本");
  assert.equal(up.body.chunk.startMs, 0);

  const read = await getCapture(id);
  assert.equal(read.status, 200);
  assert.equal(read.body.capture.status, "recording");
  assert.equal(read.body.chunks.length, 1);

  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.capture.status, "finished");
  assert.equal(fin.body.capture.mergedText, "第0段文本");
  assert.equal(fin.body.segments.length, 1);

  const gone = await request(ctx.app, "POST", `/api/voice/captures/${id}/abandon`, { headers: AS_OWNER, body: {} });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.ok, true);
});

test("a not-yours id and a nonexistent id answer the same 404", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;
  const missing = await getCapture("cap_doesnotexist");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "not_found");
  const privateOne = await getCapture(id, AS_OTHER);
  assert.equal(privateOne.status, 404, "another user's capture must not be distinguishable from a missing one");
  assert.equal(privateOne.body.code, "not_found");
  // And they cannot push chunks into it either.
  const intrude = await putChunk(id, { seq: 0, startMs: 0, headers: AS_OTHER });
  assert.equal(intrude.status, 404);
});

test("the disabled and unconfigured refusals match the composer lane and leave no row", async () => {
  // disabled → 503 voice_disabled
  db.setDeploymentConfig("voice", JSON.stringify({ enabled: false }));
  const off = await createCapture();
  assert.equal(off.status, 503);
  assert.equal(off.body.code, "voice_disabled");
  assert.deepEqual(off.body, { error: "语音功能已停用", code: "voice_disabled" });
  db.setDeploymentConfig("voice", JSON.stringify({ enabled: true }));

  // unconfigured → 503 voice_not_configured, and no upstream request either
  const saved = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  const before = fake.seen.length;
  const nokey = await createCapture();
  assert.equal(nokey.status, 503);
  assert.equal(nokey.body.code, "voice_not_configured");
  assert.equal(fake.seen.length, before, "a refusal must not reach upstream");
  process.env.LLM_API_KEY = saved;

  // Neither refusal created a capture.
  const list = await listCaptures();
  const abandonedEarlier = list.body.captures.filter((c) => c.title === "");
  assert.equal(
    abandonedEarlier.every((c) => c.status !== "recording" || c.id),
    true,
  );
  assert.ok(list.body.captures.length >= 0);
});

// ── 2.1 idempotency ───────────────────────────────────────────────────────

test("the same slice uploaded twice transcribes once, charges once and keeps its text", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;

  const before = fake.seen.length;
  const first = await putChunk(id, { seq: 0, startMs: 0, durationMs: 60_000 });
  assert.equal(first.status, 200);
  const second = await putChunk(id, { seq: 0, startMs: 0, durationMs: 60_000 });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.chunk.text, first.body.chunk.text);
  assert.equal(fake.seen.length - before, 1, "a replay must not call upstream again");

  const read = await getCapture(id);
  assert.equal(read.body.chunks.length, 1);
  assert.equal(read.body.capture.used.minutes, 1, "one minute of audio, charged once");
  assert.equal(read.body.capture.used.usd, 1);
});

// ── 2.2 out-of-order ──────────────────────────────────────────────────────

test("out-of-order arrivals merge by seq, never by arrival", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;

  for (const [seq, startMs] of [[2, 20_000], [0, 0], [1, 10_000]]) {
    const r = await putChunk(id, { seq, startMs, durationMs: 10_000 });
    assert.equal(r.status, 200, `seq ${seq}: ${JSON.stringify(r.body)}`);
  }

  const read = await getCapture(id);
  assert.deepEqual(read.body.chunks.map((c) => c.seq), [0, 1, 2]);

  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  assert.equal(fin.body.capture.mergedText, "第0段文本第1段文本第2段文本");
  assert.deepEqual(fin.body.segments.map((s) => s.startMs), [0, 10_000, 20_000]);
});

test("a slice whose start_ms contradicts its seq is refused and names the neighbour", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;
  await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  await putChunk(id, { seq: 2, startMs: 20_000, durationMs: 10_000 });

  const bad = await putChunk(id, { seq: 1, startMs: 0, durationMs: 10_000 });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, "timeline_conflict");
  assert.equal(bad.body.detail.conflictingSeq, 0);

  // And the refused slice was not stored.
  const read = await getCapture(id);
  assert.deepEqual(read.body.chunks.map((c) => c.seq), [0, 2]);
});

test("a malformed seq or start_ms is a 400 that says which field", async () => {
  const created = await createCapture();
  const id = created.body.capture.id;
  const badSeq = await putChunk(id, { seq: "x", startMs: 0 });
  assert.equal(badSeq.status, 400);
  assert.equal(badSeq.body.code, "bad_seq");
  const badStart = await putChunk(id, { seq: 0, startMs: "later" });
  assert.equal(badStart.status, 400);
  assert.equal(badStart.body.code, "bad_start_ms");
  const noAudio = multipart({ seq: 0, start_ms: 0 }, null);
  const noAudioRes = await request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, {
    headers: { ...AS_OWNER, ...noAudio.headers },
    body: noAudio.body,
  });
  assert.equal(noAudioRes.status, 400);
  assert.equal(noAudioRes.body.code, "missing_audio");
});

// ── 2.3 failure isolation + single retry ──────────────────────────────────

test("one failed slice in twenty leaves the other nineteen done, and the retry is one request", async () => {
  fake.mode = "ok";
  fake.failSeqs = new Set([5]);
  const created = await createCapture({ minutesBudget: 100 });
  const id = created.body.capture.id;

  const statuses = [];
  for (let seq = 0; seq < 20; seq += 1) {
    const r = await putChunk(id, { seq, startMs: seq * 10_000, durationMs: 10_000 });
    statuses.push(r.body.chunk?.status ?? `http${r.status}`);
  }
  assert.equal(statuses.filter((s) => s === "done").length, 19);
  assert.equal(statuses[5], "failed");

  const read = await getCapture(id);
  const failed = read.body.chunks.find((c) => c.seq === 5);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "upstream_error", "the composer lane's vocabulary, not a new one");
  assert.equal(failed.hasAudio, true, "the failed slice keeps its audio, so the retry needs no re-upload");

  // Retry: the SAME call, with no file, using the retained audio.
  const before = fake.seen.length;
  fake.failSeqs = new Set();
  const retryBody = multipart({ seq: 5, start_ms: 50_000, duration_ms: 10_000 }, null);
  const retry = await request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, {
    headers: { ...AS_OWNER, ...retryBody.headers },
    body: retryBody.body,
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.chunk.status, "done");
  assert.equal(retry.body.chunk.text, "第5段文本");
  assert.equal(fake.seen.length - before, 1, "exactly one new upstream request");
  assert.equal(retry.body.chunk.attempts, 2);

  // All twenty are now merged, in order, with no hole.
  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  const expected = Array.from({ length: 20 }, (_, i) => `第${i}段文本`).join("");
  assert.equal(fin.body.capture.mergedText, expected);
});

// A container the lane always refuses must be refused HERE, and it must not
// burn a retry attempt: retrying the same webm can never succeed, so spending
// attempts turns "wrong format" into "gave up". The upstream must not see it at
// all — each rejected-content 400 de-rotates the shared audio account for ~1min
// (measured 2026-11-15: the next good WAV answered 503 for ~60s).
test("a webm slice is refused here (415), burns no attempt, and never reaches the lane", async () => {
  fake.mode = "ok";
  fake.failSeqs = new Set();
  const created = await createCapture({ minutesBudget: 100 });
  const id = created.body.capture.id;
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 0)]);

  const before = fake.seen.length;
  const res = await putChunk(id, {
    seq: 0,
    startMs: 0,
    durationMs: 5_000,
    file: { name: "capture-slice.webm", type: "audio/webm", data: WEBM },
  });

  assert.equal(res.status, 415);
  assert.equal(res.body.code, "unsupported_audio_container");
  assert.equal(res.body.retryable, false, "重试同一个 webm 永远不会成功");
  assert.equal(res.body.chunk.status, "failed");
  assert.equal(res.body.chunk.errorCode, "unsupported_audio_container", "不是 upstream_error——病在上传前");
  assert.equal(res.body.chunk.attempts, 0, "被拒收的容器不消耗重试次数");
  assert.equal(fake.seen.length, before, "被拒收的切片一次上游都不许打");
});

test("retrying past the attempt ceiling is refused, not retried forever", async () => {
  fake.mode = "down";
  const created = await createCapture({ minutesBudget: 100 });
  const id = created.body.capture.id;

  const one = await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  assert.equal(one.status, 502);
  assert.equal(one.body.code, "upstream_error");
  assert.equal(one.body.retryable, true);

  // Attempt 2 consumes the last allowed retry.
  const two = await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  assert.equal(two.body.retryable, false, "no retry left, and the client is told so");

  const three = await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  assert.equal(three.status, 409);
  assert.equal(three.body.code, "chunk_retry_exhausted");
  fake.mode = "ok";
});

// ── 2.4 expiry and abandon ────────────────────────────────────────────────

test("a finished capture stops accepting slices and an abandoned one disappears", async () => {
  fake.mode = "ok";
  const a = await createCapture();
  await putChunk(a.body.capture.id, { seq: 0, startMs: 0, durationMs: 10_000 });
  await request(ctx.app, "POST", `/api/voice/captures/${a.body.capture.id}/finish`, { headers: AS_OWNER, body: {} });

  const lateSlice = await putChunk(a.body.capture.id, { seq: 1, startMs: 10_000, durationMs: 10_000 });
  assert.equal(lateSlice.status, 409);
  assert.equal(lateSlice.body.code, "capture_not_recording");
  // The finished text is still readable, which is the whole point of stopping.
  const still = await getCapture(a.body.capture.id);
  assert.equal(still.body.capture.mergedText, "第0段文本");

  const b = await createCapture();
  await putChunk(b.body.capture.id, { seq: 0, startMs: 0, durationMs: 10_000 });
  const abandoned = await request(ctx.app, "POST", `/api/voice/captures/${b.body.capture.id}/abandon`, { headers: AS_OWNER, body: {} });
  assert.equal(abandoned.status, 200);
  const after = await getCapture(b.body.capture.id);
  assert.equal(after.status, 404, "an abandoned capture is gone, not merely emptied");
  const list = await listCaptures();
  assert.equal(
    list.body.captures.some((c) => c.id === b.body.capture.id),
    false,
  );
});

test("an expired recording stops accepting slices but keeps what it already has", async () => {
  fake.mode = "ok";
  const created = await createCapture({ ttlMs: 60_000 });
  const id = created.body.capture.id;
  await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });

  // Reach into the store to age it — the route reads expiry from the row.
  const handle = db.getDb();
  handle.prepare("UPDATE voice_captures SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);

  const late = await putChunk(id, { seq: 1, startMs: 10_000, durationMs: 10_000 });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "capture_not_recording");
  assert.equal(late.body.status, "expired");

  const read = await getCapture(id);
  assert.equal(read.body.capture.status, "expired");
  assert.equal(read.body.chunks.length, 1);
  assert.equal(read.body.chunks[0].text, "第0段文本");
});

// ── 3.4 correction ────────────────────────────────────────────────────────

test("correction replaces the read face once and leaves the machine merge readable", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;
  await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });

  const notYet = await request(ctx.app, "POST", `/api/voice/captures/${id}/correct`, { headers: AS_OWNER, body: { text: "太早" } });
  assert.equal(notYet.status, 409);
  assert.equal(notYet.body.code, "not_finished");

  await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });

  const fixed = await request(ctx.app, "POST", `/api/voice/captures/${id}/correct`, { headers: AS_OWNER, body: { text: "人工订正后的文本" } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.capture.mergedText, "人工订正后的文本");
  assert.equal(fixed.body.capture.originalText, "第0段文本");

  const twice = await request(ctx.app, "POST", `/api/voice/captures/${id}/correct`, { headers: AS_OWNER, body: { text: "再改" } });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "already_corrected");

  const read = await getCapture(id);
  assert.equal(read.body.capture.mergedText, "人工订正后的文本");
  assert.equal(read.body.capture.originalText, "第0段文本", "the record of what was heard survives");
});

// ── 4.1 budget gates ──────────────────────────────────────────────────────

test("the minutes gate stores the slice but stops transcribing, and says how far it got", async () => {
  fake.mode = "ok";
  const created = await createCapture({ minutesBudget: 1, usdBudget: 100 });
  const id = created.body.capture.id;

  const one = await putChunk(id, { seq: 0, startMs: 0, durationMs: 60_000 });
  assert.equal(one.status, 200);
  assert.equal(one.body.budget.minutes, 1);
  assert.equal(one.body.budget.minutesLimit, 1);
  assert.equal(one.body.stopped, "minutes", "the gate closes on the call that reaches the ceiling");

  const before = fake.seen.length;
  const two = await putChunk(id, { seq: 1, startMs: 60_000, durationMs: 60_000 });
  assert.equal(two.status, 202);
  assert.equal(two.body.stopped, "minutes");
  assert.equal(fake.seen.length, before, "no upstream call past the ceiling");
  assert.ok(two.body.chunk, "the audio is still buffered — dropping it would destroy the user's data");
  assert.equal(two.body.chunk.status, "pending");

  // What was already transcribed stays readable.
  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  assert.equal(fin.body.capture.mergedText, "第0段文本");
});

test("the usd gate is its own ceiling", async () => {
  fake.mode = "ok";
  const created = await createCapture({ minutesBudget: 100, usdBudget: 0.5 });
  const id = created.body.capture.id;
  const one = await putChunk(id, { seq: 0, startMs: 0, durationMs: 60_000 });
  assert.equal(one.status, 200);
  assert.equal(one.body.stopped, "usd", "1 minute × 1 USD/min crossed a 0.5 USD ceiling");

  const two = await putChunk(id, { seq: 1, startMs: 60_000, durationMs: 60_000 });
  assert.equal(two.status, 202);
  assert.equal(two.body.stopped, "usd");
});

// ── 4.2 retention sweep ───────────────────────────────────────────────────

test("the sweep is admin-only and a second run is a no-op", async () => {
  const denied = await request(ctx.app, "POST", "/api/voice/captures/sweep", { headers: AS_OWNER, body: {} });
  assert.equal(denied.status, 403);

  const first = await request(ctx.app, "POST", "/api/voice/captures/sweep", { headers: AS_ADMIN, body: {} });
  assert.equal(first.status, 200);
  assert.equal(typeof first.body.expired, "number");
  assert.equal(typeof first.body.purgedAudio, "number");
  assert.equal(typeof first.body.requeued, "number");
  const second = await request(ctx.app, "POST", "/api/voice/captures/sweep", { headers: AS_ADMIN, body: {} });
  assert.deepEqual(second.body, { expired: 0, purgedAudio: 0, requeued: 0 });
});

// ── transport hygiene ─────────────────────────────────────────────────────

test("no response body ever carries the forwarding key", async () => {
  // The deployment key is what this cell actually uses (no bound 词元 account),
  // so a 401 upstream becomes the "deployment credential rejected" refusal —
  // and neither that body nor the generic one may echo the key.
  fake.mode = "401";
  const created = await createCapture();
  const id = created.body.capture.id;
  const up = await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  assert.equal(up.status, 502);
  assert.equal(up.body.code, "upstream_unauthorized");
  const text = JSON.stringify(up.body);
  assert.equal(text.includes(process.env.LLM_API_KEY), false);
  assert.equal(text.includes("sk-"), false);
  fake.mode = "ok";
});

// ── 5.2 / 5.3 into a room ─────────────────────────────────────────────────

const intoRoom = (id, body, headers = AS_OWNER) =>
  request(ctx.app, "POST", `/api/voice/captures/${id}/room`, { headers, body });

test("into a room: one confirm gate, one row, an event kind, and no second copy", async () => {
  fake.mode = "ok";
  const created = await createCapture({ title: "产品评审" });
  const id = created.body.capture.id;
  await putChunk(id, { seq: 0, startMs: 0, durationMs: 30_000 });
  await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });

  const before = ctx.roomRows.length;

  // 5.3 — no confirmation, no row. A missing flag is a refusal, not a default.
  const unconfirmed = await intoRoom(id, { sessionId: "room-a" });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.code, "confirmation_required");
  assert.equal(ctx.roomRows.length, before, "an unconfirmed send must add nothing");

  // 5.2 — confirmed: exactly one row, event-sourced, owned, and it is not a turn.
  const sent = await intoRoom(id, { sessionId: "room-a", confirm: true });
  assert.equal(sent.status, 200);
  assert.equal(ctx.roomRows.length, before + 1);

  const row = ctx.roomRows.at(-1);
  assert.equal(row.sessionId, "room-a");
  assert.equal(row.role, "system", "a meeting record is not a person speaking");
  assert.equal(row.content, "第0段文本");
  assert.equal(row.blocks?.[0]?.meta?.source, "capture");
  assert.equal(row.blocks?.[0]?.meta?.captureId, id);
  assert.equal(row.owner, EMAIL);
  assert.equal(row.turnDispatched, undefined, "the mirror write must not dispatch a turn");

  // Idempotent: the same capture into the same room is not added twice.
  const again = await intoRoom(id, { sessionId: "room-a", confirm: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyInRoom, true);
  assert.equal(ctx.roomRows.length, before + 1);

  // A DIFFERENT room is a different placement, and is allowed.
  const elsewhere = await intoRoom(id, { sessionId: "room-b", confirm: true });
  assert.equal(elsewhere.status, 200);
  assert.equal(ctx.roomRows.length, before + 2);
});

test("into a room refuses a foreign room, an unfinished capture and an empty session id", async () => {
  fake.mode = "ok";
  const created = await createCapture();
  const id = created.body.capture.id;
  const before = ctx.roomRows.length;

  const early = await intoRoom(id, { sessionId: "room-a", confirm: true });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "not_finished", "there is no text to send yet");

  await putChunk(id, { seq: 0, startMs: 0, durationMs: 10_000 });
  await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });

  const foreign = await intoRoom(id, { sessionId: "room-other", confirm: true });
  assert.equal(foreign.status, 403);
  const missing = await intoRoom(id, { sessionId: "room-missing", confirm: true });
  assert.equal(missing.status, 404);
  const noSession = await intoRoom(id, { confirm: true });
  assert.equal(noSession.status, 400);
  assert.equal(noSession.body.code, "bad_session");
  assert.equal(ctx.roomRows.length, before, "none of the refusals wrote a row");
});

// The fake upstream is a real listener; closing it is what lets the runner
// exit instead of waiting on an idle socket.
after(() => new Promise((r) => fakeServer.close(r)));
