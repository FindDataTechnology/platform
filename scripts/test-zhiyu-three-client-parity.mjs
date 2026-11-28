// Three clients, one room, one cursor (openspec: add-zhiyu-mobile-clients,
// tasks 4.2 and 7.1).
//
// 4.2 says the mini-program and the app share ONE state machine and ONE set of
// contract cases, differing only in adapter. 7.1 says that at the same cursor
// and the same moment, the three clients' views are equal field for field.
//
// Both are claims about the ABSENCE of divergence, which is exactly the kind of
// claim that looks true in review and stops being true three weeks later. So the
// contract cases below run once per adapter (SSE, long-poll, pure paging) and
// the observations are diffed: if a transport grows its own cursor rule, one of
// these rows stops matching.
//
//   node --test scripts/test-zhiyu-three-client-parity.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { TRANSPORT_KINDS, transportFor, diffViews } from "./zhiyu-transports.mjs";

const { ZhiyuRoomClient } = await import("../packages/core/src/zhiyu-room-client.ts");

const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: path.join(tmp, "data"),
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent: async (member) => ({ text: `（${member.display}的回答）` }),
    ssePollMs: 40,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  OPEN.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => ({
    get: async (p) => {
      const r = await fetch(`${base}${p}`, { headers: { "x-user": email } });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    post: async (p, body) => {
      const r = await fetch(`${base}${p}`, {
        method: "POST",
        headers: { "x-user": email, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  });
  return { cli, zhiyu, base, close: () => srv.close() };
}

async function seedRoom(cli) {
  const created = await cli("a@x").post("/api/zhiyu/rooms", { title: "三端房" });
  const roomId = created.body.room.id;
  for (const text of ["一", "二", "三"]) await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: text });
  return roomId;
}

/** One contract case: open the room, then behave, and hand back the observation. */
async function runContract({ base, roomId, headers, tailCount = 10, pageSize = 10 }) {
  const observed = {};
  const clientOf = (kind) =>
    new ZhiyuRoomClient({
      transport: transportFor(kind, { base, roomId, headers }),
      roomId,
      tailCount,
      pageSize,
    });

  for (const kind of TRANSPORT_KINDS) {
    const client = clientOf(kind);
    const opened = await client.start();
    observed[kind] = { opened };
    // One increment with nothing new: must not duplicate, must not rewind.
    const idle = await client.poll(0);
    observed[kind].idle = idle;
  }
  return observed;
}

const view = (state) => state.messages.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, visibility: m.visibility }));

// ── 4.2 one suite, three adapters ─────────────────────────────────────────

test("4.2 the same contract cases pass on all three adapters", async () => {
  const { cli, zhiyu, base, close } = await boot();
  const roomId = await seedRoom(cli);
  // The room's own rows are the expectation (creating a room emits a system
  // row, and hardcoding "3 messages" would encode that away).
  const rows = zhiyu.store.messagesTail(roomId, 100, { viewerMemberId: null });
  const newest = rows[rows.length - 1].seq;
  const observed = await runContract({ base, roomId, headers: { "x-user": "a@x" } });

  for (const kind of TRANSPORT_KINDS) {
    const { opened, idle } = observed[kind];
    // tail start: the newest rows, in order, and nothing invented
    assert.deepEqual(
      opened.messages.map((m) => m.seq),
      rows.slice(-10).map((m) => m.seq),
      `${kind}: the tail window`,
    );
    assert.equal(opened.cursor, newest, `${kind}: the cursor is the newest row`);
    // an idle increment changes nothing
    assert.equal(idle.messages.length, opened.messages.length, `${kind}: a replay does not duplicate`);
    assert.equal(idle.cursor, newest, `${kind}: an empty increment does not move the cursor`);
    assert.equal(opened.error, null, `${kind}: no error`);
  }
  close();
});

test("4.2 a catch-up from a stale cursor behaves identically on all three", async () => {
  const { cli, zhiyu, base, close } = await boot();
  const roomId = await seedRoom(cli);
  const rows = zhiyu.store.messagesTail(roomId, 100, { viewerMemberId: null });
  const first = rows[0].seq;
  const missed = rows.slice(1).map((m) => m.seq);
  const newest = rows[rows.length - 1].seq;
  const resumed = {};
  for (const kind of TRANSPORT_KINDS) {
    const client = new ZhiyuRoomClient({
      transport: transportFor(kind, { base, roomId, headers: { "x-user": "a@x" } }),
      roomId,
      tailCount: 5,
      pageSize: 10,
      resumedFrom: first, // saw the first row, missed everything after it
    });
    resumed[kind] = await client.start();
  }
  for (const kind of TRANSPORT_KINDS) {
    assert.deepEqual(
      resumed[kind].messages.map((m) => m.seq),
      missed,
      `${kind}: exactly the missed rows`,
    );
    assert.equal(resumed[kind].cursor, newest);
  }
  close();
});

// ── 7.1 three views, one cursor, field-identical ──────────────────────────

test("7.1 the three views are equal field for field when sampled in parallel", async () => {
  const { cli, zhiyu, base, close } = await boot();
  const roomId = await seedRoom(cli);

  // A private window belonging to the viewer: visible to them on every
  // transport, and a differing visibility tag would show up in the diff.
  const seat = zhiyu.store.membersOf(roomId).find((m) => m.kind === "user" && m.ref === "a@x");
  zhiyu.store.messageAppend({
    roomId,
    kind: "human",
    senderMemberId: seat.id,
    visibility: `private:${seat.id}`,
    content: "自己的私窗",
  });
  // …and one belonging to somebody else, which nobody here may see.
  zhiyu.store.messageAppend({
    roomId,
    kind: "human",
    senderMemberId: "mem_other",
    visibility: "private:mem_other",
    content: "别人的私窗",
  });

  const headers = { "x-user": "a@x" };
  const clients = TRANSPORT_KINDS.map((kind) => ({
    kind,
    client: new ZhiyuRoomClient({ transport: transportFor(kind, { base, roomId, headers }), roomId, tailCount: 20, pageSize: 20 }),
  }));

  // Sample in parallel: same room, same cursor (0), same moment.
  const started = await Promise.all(clients.map((c) => c.client.start()));
  const views = Object.fromEntries(clients.map((c, i) => [c.kind, view(started[i])]));

  assert.deepEqual(diffViews(views), [], "the three views must agree field for field");
  for (const kind of TRANSPORT_KINDS) {
    const texts = views[kind].map((m) => m.content);
    assert.ok(texts.includes("自己的私窗"), `${kind}: the viewer's own private row is visible`);
    assert.equal(texts.includes("别人的私窗"), false, `${kind}: somebody else's private row is not`);
    const expected = zhiyu.store.messagesTail(roomId, 100, { viewerMemberId: seat.id }).length;
    assert.equal(views[kind].length, expected, `${kind}: shared rows + the viewer's own private row`);
  }
  close();
});

test("7.1 a concurrent append lands identically on all three", async () => {
  const { cli, base, close } = await boot();
  const roomId = await seedRoom(cli);
  const headers = { "x-user": "a@x" };
  const clients = TRANSPORT_KINDS.map((kind) => ({
    kind,
    client: new ZhiyuRoomClient({ transport: transportFor(kind, { base, roomId, headers }), roomId, tailCount: 10 }),
  }));
  await Promise.all(clients.map((c) => c.client.start()));

  // Speak once, then let all three catch up from where they are.
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "刚说的" });
  const caught = await Promise.all(clients.map((c) => c.client.poll(1_500)));
  const views = Object.fromEntries(clients.map((c, i) => [c.kind, view(caught[i])]));
  assert.deepEqual(diffViews(views), []);
  for (const kind of TRANSPORT_KINDS) {
    assert.equal(views[kind].at(-1).content, "刚说的", `${kind}: the new row arrived`);
  }
  close();
});

/**
 * The transports' own contract, below the state machine.
 *
 * This one exists because the client MASKS a broken transport: `poll()` takes
 * `Math.max(serverCursor, lastRowSeen)`, so a transport that returns a stale
 * cursor still produces a correct view — it just re-reads the same window
 * forever. A view-only parity check therefore cannot see that bug (proven by
 * injecting exactly it: every view assertion above stays green). So the
 * transports are also compared on their raw output.
 */
test("7.1 at one cursor the three transports agree on the rows AND the next cursor", async () => {
  const { cli, zhiyu, base, close } = await boot();
  const roomId = await seedRoom(cli);
  const headers = { "x-user": "a@x" };
  const rows = zhiyu.store.messagesTail(roomId, 100, { viewerMemberId: null });
  const from = rows[0].seq; // ask for everything after the first row

  const raw = {};
  for (const kind of TRANSPORT_KINDS) {
    const transport = transportFor(kind, { base, roomId, headers });
    raw[kind] = await transport.increment(from, 1_500);
  }
  const expected = rows.slice(1).map((m) => m.seq);
  for (const kind of TRANSPORT_KINDS) {
    assert.deepEqual(raw[kind].messages.map((m) => m.seq), expected, `${kind}: the same rows`);
    assert.equal(raw[kind].cursor, rows[rows.length - 1].seq, `${kind}: the same next cursor`);
  }
  const views = Object.fromEntries(TRANSPORT_KINDS.map((k) => [k, raw[k].messages.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, visibility: m.visibility }))]));
  assert.deepEqual(diffViews(views), []);
  close();
});

// ── the diff helper is not vacuous ────────────────────────────────────────

test("7.1 the diff helper reports a real difference instead of passing silently", () => {
  const a = [{ seq: 1, kind: "human", content: "一", visibility: "shared" }];
  const same = [{ seq: 1, kind: "human", content: "一", visibility: "shared" }];
  const other = [{ seq: 1, kind: "human", content: "一", visibility: "private:x" }];
  assert.deepEqual(diffViews({ sse: a, polling: same }), []);
  const diffs = diffViews({ sse: a, polling: other });
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /visibility/);
  assert.equal(diffViews({ sse: a, polling: [] }).length, 1);
});
