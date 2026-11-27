// Transport parity: SSE vs the polling stream (openspec:
// add-zhiyu-mobile-clients, tasks 1.1–1.4).
//
// A mobile client cannot hold a long connection, so it polls. The moment two
// transports answer "what is new for me", they can disagree — and the failure is
// not cosmetic: one of them leaks somebody's private window, or hides the
// viewer's own. So the assertions here are about EQUALITY between the two paths
// on the same cursor and viewer, not about either one being plausible.
//
//   node --test scripts/test-zhiyu-stream-parity.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-stream-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent: async (member) => ({ text: `（${member.display}的回答）` }),
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  OPEN.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body, extraHeaders = {}) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { get: (p, h) => call("GET", p, undefined, h), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  return { cli, zhiyu, close: () => srv.close() };
}

/** A room with the owner plus an invited, accepted second member. */
async function seedRoom(cli, _zhiyu, ownerEmail, otherEmail = "b@x") {
  const created = await cli(ownerEmail).post("/api/zhiyu/rooms", { title: "移动端" });
  const roomId = created.body.room.id;
  const invited = await cli(ownerEmail).post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: otherEmail });
  await cli(otherEmail).post(`/api/zhiyu/invites/${invited.body.invite.id}/accept`, {});
  return { roomId, owner: cli(ownerEmail), other: cli(otherEmail) };
}

const page = (client, roomId, query) => client.get(`/api/zhiyu/rooms/${roomId}/messages${query}`);
const stream = (client, roomId, query) => client.get(`/api/zhiyu/rooms/${roomId}/stream${query}`);

// ── 1.2 the increment semantics ───────────────────────────────────────────

test("1.2 with nothing new the stream waits, then returns an empty increment and the same cursor", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  // Read until the cursor stops moving: seeding appends rows asynchronously
  // (a join event can land after the invite returns), so "the room is quiet" is
  // something to observe, not to assume. Under load the old version of this
  // test failed only because a late row arrived between its two reads.
  let cursor = 0;
  let previous = -1;
  while (cursor !== previous) {
    previous = cursor;
    const r = await stream(owner, roomId, `?after=${cursor}&wait=0`);
    assert.equal(r.status, 200);
    cursor = r.body.cursor;
  }
  assert.ok(cursor > 0, "the cursor comes from the last row handed back");

  const started = Date.now();
  const empty = await stream(owner, roomId, `?after=${cursor}&wait=120`);
  const elapsed = Date.now() - started;
  assert.deepEqual(empty.body.messages, []);
  assert.equal(empty.body.cursor, cursor, "an empty increment must not move the cursor");
  assert.ok(elapsed >= 100, `it held for the wait window (${elapsed}ms)`);
  close();
});

test("1.2 a new row wakes a held stream early and advances the cursor", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  const first = await stream(owner, roomId, "?after=0&wait=0");
  const cursor = first.body.cursor;

  const started = Date.now();
  const held = stream(owner, roomId, `?after=${cursor}&wait=8000`);
  // Speak a moment later: the request must come back BEFORE its deadline.
  setTimeout(() => void owner.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "新消息" }), 120);
  const out = await held;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `woke early, took ${elapsed}ms`);
  assert.equal(out.body.messages.length, 1);
  assert.equal(out.body.messages[0].content, "新消息");
  assert.ok(out.body.cursor > cursor);
  close();
});

test("1.2 the wait parameter is bounded and validated", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  const bad = await stream(owner, roomId, "?after=0&wait=abc");
  assert.equal(bad.status, 400);
  const negative = await stream(owner, roomId, "?after=0&wait=-5");
  assert.equal(negative.status, 400);
  close();
});

// ── 1.1 / 1.3 parity between the two transports ───────────────────────────

test("1.1 the same cursor yields the same rows on paging and streaming", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  for (const text of ["一", "二", "三"]) {
    await owner.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: text });
  }
  const cursor = 0;
  const paged = await page(owner, roomId, `?after=${cursor}`);
  const streamed = await stream(owner, roomId, `?after=${cursor}&wait=0`);
  assert.deepEqual(streamed.body.messages, paged.body.messages, "byte-identical rows on both transports");
  assert.equal(streamed.body.cursor, paged.body.messages.at(-1).seq);
  close();
});

test("1.3 a private window is neither leaked to others nor hidden from its owner", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");

  const me = zhiyu.store.membersOf(roomId).find((m) => m.kind === "user" && m.ref === "a@x");
  assert.ok(me, "the owner has a user seat");

  // A window belonging to somebody else. The read filter keys on the visibility
  // string, so this row is what "another member's private window" looks like to
  // these two transports — no second account needs to exist to test that.
  zhiyu.store.messageAppend({
    roomId,
    kind: "human",
    senderMemberId: "mem_someone_else",
    visibility: "private:mem_someone_else",
    content: "只给 b 看的",
  });
  await owner.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "公开的" });

  for (const [label, fn] of [
    ["paging", (c) => page(c, roomId, "?after=0")],
    ["streaming", (c) => stream(c, roomId, "?after=0&wait=0")],
  ]) {
    const out = await fn(owner);
    const texts = out.body.messages.map((m) => m.content);
    assert.equal(texts.includes("只给 b 看的"), false, `${label}: another member's private window must not leak`);
    assert.equal(texts.includes("公开的"), true, `${label}: the shared row must be there`);
  }
  close();
});

test("1.3 an own private row is visible on both transports for its owner", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  const me = zhiyu.store.membersOf(roomId).find((m) => m.kind === "user" && m.ref === "a@x");
  assert.ok(me, "the owner has a user seat");
  zhiyu.store.messageAppend({
    roomId,
    kind: "human",
    senderMemberId: me.id,
    visibility: `private:${me.id}`,
    content: "只给我看的",
  });

  for (const [label, out] of [
    ["paging", await page(owner, roomId, "?after=0")],
    ["streaming", await stream(owner, roomId, "?after=0&wait=0")],
  ]) {
    assert.equal(
      out.body.messages.some((m) => m.content === "只给我看的"),
      true,
      `${label}: my own private row must not be hidden from me`,
    );
  }
  close();
});

// ── 1.4 no per-client branches ────────────────────────────────────────────

test("1.4 the same request answers identically whatever the client claims to be", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, owner } = await seedRoom(cli, zhiyu, "a@x");
  await owner.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "同一" });

  const asBrowser = await stream(owner, roomId, "?after=0&wait=0", {
    "user-agent": "Mozilla/5.0 (Macintosh)",
    "x-client": "web",
  });
  const asWechat = await stream(owner, roomId, "?after=0&wait=0", {
    "user-agent": "Mozilla/5.0 (iPhone) MicroMessenger/8.0",
    "x-client": "miniapp",
  });
  const asApp = await stream(owner, roomId, "?after=0&wait=0", { "user-agent": "okhttp/4.12", "x-client": "app" });
  assert.deepEqual(asWechat.body, asBrowser.body);
  assert.deepEqual(asApp.body, asBrowser.body);

  // And the source carries no client sniffing in this lane at all: the server
  // is not allowed to know what kind of client is asking (1.4).
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "gateway/zhiyu/index.js"), "utf8");
  assert.equal(/isMobile|isMiniApp|x-client-type|deviceType/.test(src), false, "no client-type branch in the gateway");
  const streamRoute = src.split('/api/zhiyu/rooms/:id/stream')[1] ?? "";
  assert.equal(/user-agent/i.test(streamRoute.slice(0, 2000)), false, "the stream route reads no UA");
  close();
});
