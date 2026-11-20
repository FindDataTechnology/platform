// Attribution over the real routes (openspec: add-speaker-attribution, 5.x /
// 6.2 / 6.3 / 7.3).
//
// The ladder's pure rules are proven elsewhere. What is only provable here is
// that the wire agrees: that a finished capture derives anonymous rows and says
// the场 was not separated, that a card lands in the EXISTING todo surface and
// answering it there is adopted, that rebinding does not rewrite history, and
// that attribution never becomes authorization.
//
//   node --test scripts/test-speaker-attribution-bind.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speaker-attr-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers: [] }));
process.env.LLM_API_KEY = ["sk-attr", "seed-0000"].join("-");
delete process.env.VOICE_API_KEY;
delete process.env.VOICE_CONFIG;

// A transcription lane that answers by slice index.
const fakeServer = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts).toString("latin1");
    const m = /filename="[^"]*-(\d+)"/.exec(raw);
    const seq = m ? Number(m[1]) : -1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: `第${seq}段内容` }));
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.VOICE_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const voice = await import("../server/routes/voice.js");
const { listPendingForOwner, answerInputRequest } = await import("../server/input-requests.js");
const { decideDispatch } = await import("../server/speaker-attribution.js");

const OWNER = "owner@x.test";
const COLLEAGUE = "colleague@x.test";
const AS_OWNER = { "x-forwarded-email": OWNER, "x-forwarded-groups": "" };
const AS_COLLEAGUE = { "x-forwarded-email": COLLEAGUE, "x-forwarded-groups": "" };

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
  const boundary = `----attr${Date.now()}${Math.random().toString(16).slice(2)}`;
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

const SLICE = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(512, 9)]);
const ctx = {
  app: express().use(express.json()),
  authMode: "forward_auth",
  authEnabled: true,
  ssoEnabled: false,
  headerTrust: null,
  CLOUD_MODE: true,
  logtoAuth: null,
  broadcasts: [],
  cellId: "cell-attr",
  // The "who was present" seam: a room roster does not exist yet, so this test
  // supplies one explicitly rather than letting a guess in through the default.
  capturePresentMembers: () => [OWNER, COLLEAGUE],
};
ctx.broadcast = () => {};
registerAuth(ctx);
voice.registerVoiceRoutes(ctx);

async function finishedCapture({ speakerMode = "shared", title = "会议", slices = 2 } = {}) {
  const created = await request(ctx.app, "POST", "/api/voice/captures", {
    headers: AS_OWNER,
    body: { title, speakerMode },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.capture.id;
  for (let seq = 0; seq < slices; seq += 1) {
    const m = multipart(
      { seq, start_ms: seq * 30_000, duration_ms: 30_000 },
      { name: "s.m4a", type: "audio/mp4", data: SLICE },
    );
    const up = await request(ctx.app, "POST", `/api/voice/captures/${id}/chunks`, {
      headers: { ...AS_OWNER, ...m.headers },
      body: m.body,
    });
    assert.equal(up.body?.chunk?.status, "done", JSON.stringify(up.body));
  }
  const fin = await request(ctx.app, "POST", `/api/voice/captures/${id}/finish`, { headers: AS_OWNER, body: {} });
  assert.equal(fin.status, 200);
  return { id, fin };
}

const view = (id, headers = AS_OWNER) =>
  request(ctx.app, "GET", `/api/voice/captures/${id}/attributions`, { headers });

test("a finished shared capture is anonymous and SAYS the场 was not separated", async () => {
  const { id, fin } = await finishedCapture({ title: "共享麦克风" });
  assert.equal(fin.body.capture.speakerMode, "shared");

  const v = await view(id);
  assert.equal(v.status, 200);
  assert.equal(v.body.separated, false, "no separation happened, and the view says so");
  assert.equal(v.body.attributions.length, 2);
  for (const row of v.body.attributions) {
    assert.equal(row.certainty, "anonymous");
    assert.equal(row.cluster, "anonymous");
    assert.equal(row.member, null);
    assert.match(row.basis, /未做分离/);
  }
  assert.equal(v.body.summary.needsConfirmation, 2);
  assert.equal(v.body.summary.dispatchable, 0);
});

test("6.2 the confirmation lands in the EXISTING todo surface, not a new inbox", async () => {
  const { id } = await finishedCapture({ title: "待确认" });
  const pending = listPendingForOwner(db.getDb(), OWNER);
  const card = pending.find((p) => p.id === `spkreq_${id}_anonymous`);
  assert.ok(card, "a card for this capture's anonymous bucket must be pending");
  assert.equal(card.card.type, "choice");
  assert.match(card.card.title, /谁/);
  // The candidates ARE the present members — no free-text identity.
  const options = card.card.fields[0].options.map((o) => o.value);
  assert.deepEqual(options.sort(), [COLLEAGUE, OWNER].sort());
  // And the basis is in the card, so the human knows why they are being asked.
  assert.match(card.card.detail, /未做分离/);
});

test("6.2 answering the card on the todo surface is adopted by the attribution view", async () => {
  const { id } = await finishedCapture({ title: "从待办回答" });
  const card = listPendingForOwner(db.getDb(), OWNER).find((p) => p.id === `spkreq_${id}_anonymous`);
  assert.ok(card);
  answerInputRequest(db.getDb(), card.id, { values: { member: COLLEAGUE }, answeredBy: OWNER });

  const v = await view(id);
  assert.equal(v.status, 200);
  assert.equal(v.body.adopted.length, 1, "the answer became a binding on this read");
  const row = v.body.attributions[0];
  assert.equal(row.member, COLLEAGUE);
  assert.equal(row.certainty, "bound");
  // Now, and only now, does this content have a member to dispatch to.
  assert.equal(decideDispatch({ certainty: row.certainty, hasTeam: true }).dispatch, true);
});

test("5.1 / 5.2 bind, rebind and unbind each answer the view and the trail", async () => {
  const { id } = await finishedCapture({ title: "贴名" });

  const foreign = await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: "stranger@x.test" },
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.code, "member_not_present");

  const bound = await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: COLLEAGUE },
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.op, "bind");
  assert.equal(bound.body.attributions[0].member, COLLEAGUE);

  const rebound = await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: OWNER },
  });
  assert.equal(rebound.body.op, "rebind");
  assert.equal(rebound.body.previous, COLLEAGUE);

  const unbound = await request(ctx.app, "POST", `/api/voice/captures/${id}/unbind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous" },
  });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.body.attributions[0].member, null);
  assert.equal(unbound.body.attributions[0].certainty, "anonymous");

  const v = await view(id);
  assert.deepEqual(
    v.body.events.map((e) => e.op),
    ["bind", "rebind", "unbind"],
  );
  assert.equal(v.body.events[1].from, COLLEAGUE);
  assert.equal(v.body.events[1].to, OWNER);
  assert.ok(v.body.events[1].at > 0, "the moment of the change is recorded");
  assert.equal(v.body.events[1].actor, OWNER);
});

test("3.1 a session-mode capture is the owner, dispatchable, and asks nobody", async () => {
  const { id } = await finishedCapture({ title: "个人录音", speakerMode: "session" });
  const v = await view(id);
  assert.equal(v.body.speakerMode, "session");
  for (const row of v.body.attributions) {
    assert.equal(row.certainty, "session");
    assert.equal(row.member, OWNER);
    assert.equal(row.cluster, "session");
  }
  assert.equal(v.body.summary.needsConfirmation, 0);
  assert.equal(
    listPendingForOwner(db.getDb(), OWNER).some((p) => p.id.startsWith(`spkreq_${id}_`)),
    false,
    "a certain attribution must not ask a human to confirm it",
  );
});

test("5.4 a binding is scoped to its own capture", async () => {
  const first = await finishedCapture({ title: "第一场" });
  await request(ctx.app, "POST", `/api/voice/captures/${first.id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: COLLEAGUE },
  });
  const second = await finishedCapture({ title: "第二场" });
  const v = await view(second.id);
  assert.equal(v.body.attributions[0].member, null, "the next recording starts anonymous");
  assert.equal(v.body.bindings.length, 0);
});

test("7.3 abandoning a capture takes its attribution with it", async () => {
  const { id } = await finishedCapture({ title: "放弃" });
  await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: COLLEAGUE },
  });
  assert.equal((await view(id)).body.attributions.length, 2);

  const gone = await request(ctx.app, "POST", `/api/voice/captures/${id}/abandon`, { headers: AS_OWNER, body: {} });
  assert.equal(gone.status, 200);
  const after = await view(id);
  assert.equal(after.status, 404, "the capture is gone");
  const rows = db
    .getDb()
    .prepare("SELECT COUNT(*) AS n FROM speaker_attributions WHERE capture_id = ?")
    .get(id).n;
  assert.equal(rows, 0, "no orphan attribution rows survive the abandon");
});

test("6.3 attribution is NOT authorization: a bound member still cannot read the capture", async () => {
  const { id } = await finishedCapture({ title: "授权不是归属" });
  await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_OWNER,
    body: { cluster: "anonymous", member: COLLEAGUE },
  });
  // The colleague is now "the speaker" of this content — and still owns nothing.
  const asColleague = await view(id, AS_COLLEAGUE);
  assert.equal(asColleague.status, 404, "being named as the speaker grants no access");
  const capture = await request(ctx.app, "GET", `/api/voice/captures/${id}`, { headers: AS_COLLEAGUE });
  assert.equal(capture.status, 404);
  const bindAttempt = await request(ctx.app, "POST", `/api/voice/captures/${id}/bind`, {
    headers: AS_COLLEAGUE,
    body: { cluster: "anonymous", member: COLLEAGUE },
  });
  assert.equal(bindAttempt.status, 404, "and it grants no right to re-bind either");
});

test("the biometric guard holds on the HTTP path too", async () => {
  const { id } = await finishedCapture({ title: "落库形状" });
  const row = db.getDb().prepare("SELECT * FROM speaker_attributions WHERE capture_id = ?").get(id);
  const keys = Object.keys(row).join(",");
  assert.equal(/vector|embedding|feature|audio|voiceprint/i.test(keys), false, `artifact carries: ${keys}`);
});

test.after(() => new Promise((r) => fakeServer.close(r)));
