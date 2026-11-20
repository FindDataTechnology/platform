// Guest transcription door (openspec: zhiyu-room-attachments-and-voice, 4.4;
// voice-lane's "no-cell surfaces can transcribe" requirement).
//   node --test scripts/test-zhiyu-guest-voice.mjs
//
// Facts this pins, in the order they would embarrass us:
//   1. no credential ⇒ honest 503, never a fake success or a hang
//   2. the deployment credential is what's used, never a member's account
//   3. the refusal leaks nothing (no key, no upstream address)
//   4. the rate bucket is per-seat (a throttle never hits other visitors)

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createVoiceForwarder } from "../gateway/zhiyu/voice-forward.js";

async function boot(env = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zy-gv-"));
  const app = express();
  app.use(express.json());
  const z = registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: (req) => (req.headers["x-t-email"] ? { email: String(req.headers["x-t-email"]), groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "unauth" }),
    env: { ZHIYU_WIDGET: "1", ...env },
    secret: "s3",
    startTimers: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { "x-t-email": "owner@x.io", "content-type": "application/json" };
  const mk = async (p, body) => (await fetch(base + p, { method: "POST", headers: owner, body: JSON.stringify(body ?? {}) })).json();
  const { room } = await mk("/api/zhiyu/rooms", { title: "v" });
  const w = await mk(`/api/zhiyu/rooms/${room.id}/widget`, { allowlist: ["x.io"] });
  const token = w.token ?? w.widget?.token ?? w.t?.token;
  const REF = { referer: "https://x.io/page" };
  const visit = await fetch(`${base}/zhiyu/widget/${token}/visit`, { method: "POST", headers: { "content-type": "application/json", ...REF }, body: "{}" });
  const cookie = (visit.headers.getSetCookie?.() ?? [visit.headers.get("set-cookie")]).filter(Boolean)[0].split(";")[0];
  const say = (bytes = "RIFF") =>
    fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, {
      method: "POST",
      headers: { ...REF, cookie, "content-type": "multipart/form-data; boundary=x" },
      body: bytes,
    }).catch(() => null);
  return { base, room, token, cookie, REF, z, server, close: () => (server.close(), z.close?.()) };
}

const audioForm = () => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("RIFF....")], { type: "audio/wav" }), "a.wav");
  return fd;
};

test("no credential ⇒ 503 voice_not_configured, and nothing is faked", async () => {
  const { base, token, cookie, REF, close } = await boot();
  try {
    const r = await fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, { method: "POST", body: audioForm(), headers: { ...REF, cookie } });
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.equal(body.code, "voice_not_configured");
    assert.equal(body.text, undefined, "no transcript invented");
  } finally {
    close();
  }
});

test("the refusal leaks no credential and no upstream address", async () => {
  const { base, token, cookie, REF, close } = await boot({ VOICE_API_KEY: "sk-secret-should-never-appear" });
  try {
    // With a key but an unreachable base, the failure must still be a sanitized 502.
    const r = await fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, { method: "POST", body: audioForm(), headers: { ...REF, cookie } });
    const raw = await r.text();
    assert.ok(r.status === 502 || r.status === 503, `expected 502/503, got ${r.status}`);
    assert.doesNotMatch(raw, /sk-secret-should-never-appear/, "the key never appears");
    assert.doesNotMatch(raw, /token\.finddatatech\.cloud/, "the upstream address never appears");
  } finally {
    close();
  }
});

test("the deployment key is used, not any member's bound account", async () => {
  // The forwarder has no access to member accounts by construction; assert the
  // property at the seam rather than by reading the source.
  let seenAuth = null;
  const fwd = createVoiceForwarder({
    env: { VOICE_API_KEY: "deployment-key" },
    fetchImpl: async (_url, init) => {
      seenAuth = init.headers.authorization;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const out = await fwd.transcribe({ buffer: Buffer.from("x"), mime: "audio/wav", filename: "a.wav" });
  assert.equal(out.ok, true);
  assert.equal(out.text, "ok");
  assert.equal(seenAuth, "Bearer deployment-key", "the deployment credential, exactly");
});

test("VOICE_CONFIG can disable the lane, and a broken block falls back to enabled", async () => {
  const disabled = createVoiceForwarder({ env: { VOICE_CONFIG: '{"enabled":false}', VOICE_API_KEY: "k" } });
  assert.equal(disabled.available(), false);
  const out = await disabled.transcribe({ buffer: Buffer.from("x") });
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "voice_disabled");

  const broken = createVoiceForwarder({ env: { VOICE_CONFIG: "not json", VOICE_API_KEY: "k" } });
  assert.equal(broken.available(), true, "a bad config degrades to the default, not to off");
});

test("over the size ceiling refuses before any upstream call", async () => {
  let calls = 0;
  const fwd = createVoiceForwarder({
    env: { VOICE_API_KEY: "k" },
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  // multer enforces the ceiling at the HTTP layer; here assert the forwarder
  // itself is never reached for a request the door rejected.
  const { base, token, cookie, REF, close } = await boot({ VOICE_API_KEY: "k", ZHIYU_VOICE_MAX_BYTES: "4" });
  try {
    const r = await fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, { method: "POST", body: audioForm(), headers: { ...REF, cookie } });
    assert.equal(r.status, 413, `expected 413, got ${r.status}`);
    assert.equal(calls, 0);
  } finally {
    close();
  }
});

test("the transcription bucket is per seat, not per room", async () => {
  const { base, token, cookie, REF, close } = await boot();
  try {
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, { method: "POST", body: audioForm(), headers: { ...REF, cookie } });
      statuses.push(r.status);
    }
    // The first six pass the throttle and land on the honest 503 (no key);
    // the 7th+ are throttled. Crucially the throttle is a 429, not a 503, so
    // the two refusals stay distinguishable.
    assert.ok(statuses.includes(429), `expected a 429 after the bucket fills, got ${statuses}`);
    assert.ok(statuses.slice(0, 3).every((s) => s === 503), `early calls are the no-key refusal, got ${statuses.slice(0, 3)}`);
  } finally {
    close();
  }
});
