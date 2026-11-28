// End-to-end: a one-hour recording, and a lossy network (openspec:
// add-voice-capture-lane, tasks 6.1 / 6.2).
//
// The unit suites prove the pieces; this file proves the LANE: one hour of audio
// goes in as 120 slices, every slice is transcribed, the merge is ordered, and
// NO audio survives. Then the same recording is run again with 30% of the slices
// failing, and it must still finish with complete text — a failure is retried,
// not a hole in the transcript.
//
// What this cannot prove: that the text matches the words. That needs a real
// recording and a human ear (6.1's second half) — an assertion cannot hear.
//
//   node --test scripts/test-voice-capture-e2e.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-capture-e2e-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
process.env.LLM_API_KEY = ["sk-e2e", "seed-0000"].join("-");
process.env.VOICE_ASR_USD_PER_MINUTE = "0.001";
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;

// The upstream speaks the slice index back as its "transcript", so the expected
// merged text is computable and an out-of-order merge is visible as such.
const fake = { failOnce: new Set(), seen: [], empty: 0 };
const fakeServer = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts).toString("latin1");
    // The route names the part `capture-<captureId>-<seq>`; the capture id is
    // `cap_<base64url>`, so the trailing digits are the seq.
    const m = /filename="[^"]*-(\d+)"/.exec(raw);
    const s = m ? Number(m[1]) : -1;
    fake.seen.push({ seq: s });
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url !== "/v1/audio/transcriptions") return json(404, { error: "nope" });
    // Fail once per marked slice, then succeed — a transient upstream hiccup.
    if (fake.failOnce.has(s)) {
      fake.failOnce.delete(s);
      return json(500, { error: { code: "asr_transient" } });
    }
    return json(200, { text: `第${s}段` });
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
            server.close(() => resolve({ status: res.statusCode, body: json }));
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
  const boundary = `----e2e${Date.now()}${Math.random().toString(16).slice(2)}`;
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

const ctx = {
  app: express().use(express.json()),
  authMode: "forward_auth",
  authEnabled: true,
  ssoEnabled: false,
  headerTrust: null,
  CLOUD_MODE: true,
  logtoAuth: null,
  broadcasts: [],
  cellId: "cell-e2e",
};
ctx.broadcast = () => {};
registerAuth(ctx);
voice.registerVoiceRoutes(ctx);

const CHUNK_MS = 30_000;
const HOUR = 60 * 60_000;
const SLICE_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2048, 3)]);

const { planSlices } = await import("../packages/core/src/voice-capture-slices.ts");

function upload(app, id, slice, withAudio = true) {
  const m = multipart(
    { seq: slice.seq, start_ms: slice.startMs, duration_ms: slice.durationMs },
    withAudio ? { name: "slice.m4a", type: "audio/mp4", data: SLICE_BYTES } : null,
  );
  return request(app, "POST", `/api/voice/captures/${id}/chunks`, {
    headers: { ...AS_OWNER, ...m.headers },
    body: m.body,
  });
}

async function runHour({ failSeqs = [], label }) {
  fake.failOnce = new Set(failSeqs);
  const slices = planSlices(HOUR, CHUNK_MS);
  assert.equal(slices.length, 120);

  const created = await request(ctx.app, "POST", "/api/voice/captures", {
    headers: AS_OWNER,
    body: { title: label, minutesBudget: 200, usdBudget: 100 },
  });
  assert.equal(created.status, 201);
  const id = created.body.capture.id;

  let firstPassFailed = [];
  for (const slice of slices) {
    const r = await upload(ctx.app, id, slice);
    if (r.body?.chunk?.status !== "done") firstPassFailed.push(slice.seq);
  }

  // Retry only what actually failed, with no re-upload (the audio was kept).
  for (const seq of firstPassFailed) {
    const slice = slices[seq];
    const r = await upload(ctx.app, id, slice, false);
    assert.equal(r.body?.chunk?.status, "done", `retry of slice ${seq} failed: ${JSON.stringify(r.body)}`);
  }

  const read = await request(ctx.app, "GET", `/api/voice/captures/${id}`, { headers: AS_OWNER });
  assert.equal(read.body.chunks.length, 120, "every slice is present");
  assert.equal(read.body.chunks.filter((c) => c.status === "done").length, 120, "every slice transcribed");

  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.capture.status, "finished");

  // Ordered merge: seq order, no holes, no duplicates.
  const expected = Array.from({ length: 120 }, (_, i) => `第${i}段`).join("");
  assert.equal(fin.body.capture.mergedText, expected);
  assert.deepEqual(
    fin.body.segments.map((s) => s.seq),
    Array.from({ length: 120 }, (_, i) => i),
  );

  // Audio retention: zero, by default. This is the privacy promise.
  const handle = db.getDb();
  const audioRows = handle
    .prepare("SELECT COUNT(*) AS n FROM voice_capture_chunks WHERE capture_id = ? AND audio IS NOT NULL")
    .get(id).n;
  assert.equal(audioRows, 0, "no slice audio survived transcription");

  // Budget: 60 minutes of audio, charged once.
  assert.equal(fin.body.capture.used.minutes, 60);
  return { id, firstPassFailed, fin };
}

test("6.1 one hour of audio: 120 slices, ordered merge, zero audio retained", async () => {
  const { firstPassFailed, fin } = await runHour({ label: "一小时会议" });
  assert.deepEqual(firstPassFailed, [], "a healthy lane loses nothing");
  assert.equal(fin.body.capture.used.minutes, 60);
  assert.equal(fin.body.capture.mergedText.length > 0, true);
  // The merged original is kept as its own fact, for the one human correction.
  assert.equal(fin.body.capture.originalText, fin.body.capture.mergedText);
});

test("6.2 30% slice failures: the lane still completes with complete text", async () => {
  // 36 of 120 slices fail once (exactly 30%), then succeed on retry.
  const failSeqs = Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 10 < 3);
  assert.equal(failSeqs.length, 36);

  const { firstPassFailed, fin } = await runHour({ failSeqs, label: "弱网会议" });
  assert.equal(firstPassFailed.length, 36, "exactly the injected slices failed on the first pass");
  // The retry filled every hole: the text is complete and in order. Exact
  // equality is also the no-duplication proof — a seam transcribed twice would
  // make the string longer than the expected concatenation.
  const expected = Array.from({ length: 120 }, (_, i) => `第${i}段`).join("");
  assert.equal(fin.body.capture.mergedText, expected);
});

test("6.2b the failed slices are attributable while they are still failed", async () => {
  fake.failOnce = new Set([5, 6]);
  const created = await request(ctx.app, "POST", "/api/voice/captures", {
    headers: AS_OWNER,
    body: { title: "如实标注", minutesBudget: 200 },
  });
  const id = created.body.capture.id;
  const slices = planSlices(8 * CHUNK_MS, CHUNK_MS);
  for (const slice of slices) await upload(ctx.app, id, slice);

  const read = await request(ctx.app, "GET", `/api/voice/captures/${id}`, { headers: AS_OWNER });
  const failed = read.body.chunks.filter((c) => c.status === "failed");
  assert.deepEqual(
    failed.map((c) => c.seq),
    [5, 6],
    "the transcript says WHICH slices are missing instead of pretending they were silent",
  );
  assert.deepEqual(
    failed.map((c) => c.errorCode),
    ["upstream_error", "upstream_error"],
  );
});

test.after(() => new Promise((r) => fakeServer.close(r)));
