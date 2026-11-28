// Room attachment routes, end to end against a real kernel (openspec:
// zhiyu-room-attachments-and-voice, tasks 4.1–4.5 / 7.5).
//   node --test scripts/test-zhiyu-attachment-routes.mjs
//
// The unit file proves the machine; this one proves the DOORS: the member door,
// the guest door (its own quota + pass), the read authority, and the honest
// refusal when transcription has no credential.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

async function boot(env = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zy-routes-"));
  const app = express();
  app.use(express.json());
  const z = registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: (req) => (req.headers["x-t-email"] ? { email: String(req.headers["x-t-email"]), groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "unauth" }),
    env: { ZHIYU_WIDGET: "1", ...env },
    secret: "test-secret",
    startTimers: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { "x-t-email": "owner@x.io" };
  const json = { "content-type": "application/json" };
  const call = async (method, p, body, headers = owner) => {
    const r = await fetch(base + p, { method, headers: { ...json, ...headers }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  };
  const { room } = (await call("POST", "/api/zhiyu/rooms", { title: "probe" })).body;
  return { base, room, call, owner, z, server, close: () => (server.close(), z.close?.()) };
}

const file = (content, name, mime) => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(content)], { type: mime }), name);
  return fd;
};

test("member upload → ready, row carries the ref, content readable, stranger 404", async () => {
  const { base, room, call, owner, close } = await boot();
  try {
    const up = await fetch(`${base}/api/zhiyu/rooms/${room.id}/attachments`, { method: "POST", body: file("# hi there", "notes.md", "text/markdown"), headers: owner });
    const body = await up.json();
    assert.equal(up.status, 201, `upload: ${up.status} ${JSON.stringify(body)}`);
    assert.equal(body.attachment.status, "ready");
    assert.ok(body.attachment.hasText);
    assert.ok(body.message.meta?.attachment?.id, "the row it rides carries the reference");

    const c = await fetch(`${base}/api/zhiyu/rooms/${room.id}/attachments/${body.attachment.id}/content`, { headers: owner });
    assert.equal(c.status, 200);
    assert.equal(await c.text(), "# hi there");

    const stranger = await fetch(`${base}/api/zhiyu/rooms/${room.id}/attachments/${body.attachment.id}/content`, { headers: { "x-t-email": "nobody@x.io" } });
    assert.equal(stranger.status, 404, "a non-member gets the same-as-nonexistent shape");

    const st = await call("GET", `/api/zhiyu/rooms/${room.id}/attachments/status`);
    assert.equal(st.status, 200);
    assert.ok(st.body.limits.file > 0);
  } finally {
    close();
  }
});

test("quota refusal happens before any byte lands", async () => {
  // A 1-byte room budget makes the very first upload too big for the room.
  const { base, room, owner, call, close } = await boot({ ZHIYU_ATTACHMENT_ROOM_MAX_BYTES: "1" });
  try {
    const r = await fetch(`${base}/api/zhiyu/rooms/${room.id}/attachments`, { method: "POST", body: file("hello", "big.txt", "text/plain"), headers: owner });
    const body = await r.json();
    assert.equal(r.status, 413, `expected 413, got ${r.status} ${JSON.stringify(body)}`);
    assert.equal(body.code, "room_quota_exceeded");

    // Nothing landed: no attachment row, and the room still reads empty.
    const st = await call("GET", `/api/zhiyu/rooms/${room.id}/attachments/status`);
    assert.equal(st.body.limits.roomBytesUsed, 0, "a refused upload writes nothing");

    const msgs = await call("GET", `/api/zhiyu/rooms/${room.id}/messages`);
    const withAtt = (msgs.body.messages ?? []).filter((m) => m.meta?.attachment);
    assert.equal(withAtt.length, 0, "no phantom message row was created either");
  } finally {
    close();
  }
});

test("guest door: pass required, then its own upload is room-visible", async () => {
  const { base, room, call, owner, close } = await boot();
  try {
    const w = await call("POST", `/api/zhiyu/rooms/${room.id}/widget`, { allowlist: ["x.io"] });
    const token = w.body.token ?? w.body.widget?.token ?? w.body.t?.token;
    assert.ok(token, `token: ${JSON.stringify(w.body)}`);
    const REF = { referer: "https://x.io/page" };
    const json = { "content-type": "application/json" };

    const visit = await fetch(`${base}/zhiyu/widget/${token}/visit`, { method: "POST", headers: { ...json, ...REF }, body: JSON.stringify({ host: "x.io" }) });
    assert.equal(visit.status, 200);
    const cookie = (visit.headers.getSetCookie?.() ?? [visit.headers.get("set-cookie")]).filter(Boolean)[0].split(";")[0];
    assert.ok(cookie.startsWith("zy_guest="), "the visit issues the seat pass");

    // No pass ⇒ refused, and the refusal is not a fake success.
    const anon = await fetch(`${base}/api/zhiyu/widget/${token}/attachments`, { method: "POST", body: file("x", "g.txt", "text/plain"), headers: REF });
    assert.equal(anon.status, 401);

    const gup = await fetch(`${base}/api/zhiyu/widget/${token}/attachments`, { method: "POST", body: file("guest payload", "g.txt", "text/plain"), headers: { ...REF, cookie } });
    const gbody = await gup.json();
    assert.equal(gup.status, 201, `guest upload: ${gup.status} ${JSON.stringify(gbody)}`);
    assert.equal(gbody.attachment.sourceKind, "guest");

    // Shared row ⇒ the owner can read the guest's file (that IS the point of a room).
    const c = await fetch(`${base}/api/zhiyu/rooms/${room.id}/attachments/${gbody.attachment.id}/content`, { headers: owner });
    assert.equal(c.status, 200);
    assert.equal(await c.text(), "guest payload");
  } finally {
    close();
  }
});

test("guest transcription without a credential refuses honestly and leaks nothing", async () => {
  const { base, room, call, close } = await boot();
  try {
    const w = await call("POST", `/api/zhiyu/rooms/${room.id}/widget`, { allowlist: ["x.io"] });
    const token = w.body.token ?? w.body.widget?.token ?? w.body.t?.token;
    const REF = { referer: "https://x.io/page" };
    const visit = await fetch(`${base}/zhiyu/widget/${token}/visit`, { method: "POST", headers: { "content-type": "application/json", ...REF }, body: "{}" });
    const cookie = (visit.headers.getSetCookie?.() ?? [visit.headers.get("set-cookie")]).filter(Boolean)[0].split(";")[0];
    const asr = await fetch(`${base}/api/zhiyu/widget/${token}/transcriptions`, { method: "POST", body: file("RIFF", "a.wav", "audio/wav"), headers: { ...REF, cookie } });
    const body = await asr.json();
    assert.equal(asr.status, 503);
    assert.equal(body.code, "voice_not_configured");
    assert.ok(!JSON.stringify(body).match(/sk-|Bearer|token\.finddatatech/i), "no credential or upstream address in the refusal");
  } finally {
    close();
  }
});

test("the /api/zhiyu prefix stays sealed", async () => {
  const { room, call, close } = await boot();
  try {
    const nope = await call("GET", `/api/zhiyu/rooms/${room.id}/definitely-not-a-route`);
    assert.equal(nope.status, 404);
    assert.equal(typeof nope.body, "object", "answers JSON, not the SPA shell");
  } finally {
    close();
  }
});
