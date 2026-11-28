// The room cursor state machine (openspec: add-zhiyu-mobile-clients, 2.1 / 2.3
// / 2.4).
//
// Three transports will run this one object, so the properties pinned here are
// the ones a room cannot survive getting wrong: a replay must not duplicate a
// row, a catch-up must not leave a hole, an older page must not drag the cursor
// backwards, and a cold start must resume from a PERSISTED cursor rather than
// replaying a year of history.
//
//   node --test scripts/test-zhiyu-mobile-cursor.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { ZhiyuRoomClient, mergeBySeq } = await import("../packages/core/src/zhiyu-room-client.ts");

const row = (seq, content = `第 ${seq} 行`) => ({ seq, kind: "human", content });

/** A transport over a fixed log, with the server's real cursor semantics. */
function fakeTransport(log, { incrementCap = 500 } = {}) {
  const calls = [];
  return {
    calls,
    async page({ tail, before, after, limit = 50 }) {
      calls.push({ op: "page", tail, before, after, limit });
      const sorted = [...log].sort((a, b) => a.seq - b.seq);
      if (tail !== undefined) return { messages: sorted.slice(-Math.min(tail, limit ?? tail)) };
      if (before !== undefined) {
        return { messages: sorted.filter((m) => m.seq < before).slice(-Math.min(limit, 500)) };
      }
      const start = after ?? 0;
      return { messages: sorted.filter((m) => m.seq > start).slice(0, incrementCap) };
    },
    async increment(after, waitMs) {
      calls.push({ op: "increment", after, waitMs });
      const sorted = [...log].sort((a, b) => a.seq - b.seq);
      const messages = sorted.filter((m) => m.seq > after).slice(0, incrementCap);
      const cursor = messages.length ? messages[messages.length - 1].seq : after;
      return { messages, cursor };
    },
  };
}

// ── 2.1 tail start ────────────────────────────────────────────────────────

test("2.1 tail start opens at the newest rows, not at the beginning of the room", async () => {
  const log = Array.from({ length: 200 }, (_, i) => row(i + 1));
  const transport = fakeTransport(log);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 20 });
  const state = await client.start();
  assert.equal(state.messages.length, 20);
  assert.equal(state.messages[0].seq, 181, "the tail, not the head");
  assert.equal(state.cursor, 200);
  assert.equal(state.hasOlder, true, "a full tail implies there is more behind it");
  assert.deepEqual(
    transport.calls.map((c) => c.op),
    ["page"],
    "opening the room is ONE read",
  );
});

test("2.1 a small room opens fully and reports nothing older", async () => {
  const transport = fakeTransport([row(1), row(2), row(3)]);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 20 });
  const state = await client.start();
  assert.equal(state.messages.length, 3);
  assert.equal(state.cursor, 3);
  assert.equal(state.hasOlder, false);
});

// ── 2.1 dedupe ────────────────────────────────────────────────────────────

test("2.1 a replayed row is not rendered twice", async () => {
  const log = [row(1), row(2), row(3)];
  const transport = fakeTransport(log);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10 });
  await client.start();
  // A reconnect replays from the cursor: same rows again.
  const state = await client.poll(0);
  assert.deepEqual(
    state.messages.map((m) => m.seq),
    [1, 2, 3],
  );
});

test("2.1 mergeBySeq keeps order and drops duplicates from either side", () => {
  const merged = mergeBySeq([row(1), row(3), row(5)], [row(3), row(4), row(5), row(6)]);
  assert.deepEqual(
    merged.map((m) => m.seq),
    [1, 3, 4, 5, 6],
  );
  // A row repeated inside one side is dropped too.
  assert.deepEqual(
    mergeBySeq([row(1), row(1), row(2)], []).map((m) => m.seq),
    [1, 2],
  );
});

// ── 2.1 catch-up: no hole ─────────────────────────────────────────────────

test("2.1 catch-up reads until the log is exhausted — one page is not a catch-up", async () => {
  const log = Array.from({ length: 120 }, (_, i) => row(i + 1));
  // The server hands back at most 50 rows per increment.
  const transport = fakeTransport(log, { incrementCap: 50 });
  // A client that was away resumes from an OLD cursor: 10, with 110 rows behind it.
  const resumed = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10, pageSize: 50, resumedFrom: 10 });
  const state = await resumed.start();
  assert.equal(
    state.messages.some((m) => m.seq === 60),
    true,
    "a hole in the middle is the failure mode this test exists for",
  );
  assert.equal(state.cursor, 120);
  const seqs = state.messages.map((m) => m.seq);
  assert.equal(new Set(seqs).size, seqs.length, "no row twice");
  // Strictly increasing: no gap in what was delivered.
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1]);
  assert.equal(seqs[0], 11);
  assert.equal(seqs[seqs.length - 1], 120);
});

// ── 2.1 backward paging ───────────────────────────────────────────────────

test("2.1 paging back prepends and never moves the cursor backwards", async () => {
  const log = Array.from({ length: 100 }, (_, i) => row(i + 1));
  const transport = fakeTransport(log);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10, pageSize: 10 });
  const started = await client.start();
  assert.equal(started.cursor, 100);

  const paged = await client.loadOlder();
  assert.equal(paged.messages.length, 20);
  assert.equal(paged.messages[0].seq, 81);
  assert.equal(paged.cursor, 100, "the cursor is newest-seen, not last-read");

  // Page all the way back; each page must be contiguous with the previous one.
  let state = paged;
  while (state.hasOlder) state = await client.loadOlder();
  assert.equal(state.messages[0].seq, 1);
  assert.equal(state.hasOlder, false);
  const seqs = state.messages.map((m) => m.seq);
  assert.deepEqual(
    seqs,
    Array.from({ length: 100 }, (_, i) => i + 1),
    "the whole log, in order, exactly once",
  );
  assert.equal(state.cursor, 100);
});

test("2.1 an empty backward page ends paging without losing the cursor", async () => {
  const transport = fakeTransport([row(1), row(2)]);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10, pageSize: 10 });
  await client.start();
  const state = await client.loadOlder();
  assert.equal(state.hasOlder, false);
  assert.equal(state.cursor, 2);
  assert.equal(state.messages.length, 2);
});

// ── 2.3 cold start from a persisted cursor ────────────────────────────────

test("2.3 a cold start resumes from the persisted cursor: no replay, no gap", async () => {
  const log = Array.from({ length: 60 }, (_, i) => row(i + 1));
  const transport = fakeTransport(log);

  // First life: open the room, then remember where we got to.
  let persisted = 0;
  const first = new ZhiyuRoomClient({
    transport,
    roomId: "r1",
    tailCount: 10,
    onCursor: (seq) => {
      persisted = seq;
    },
  });
  await first.start();
  assert.equal(persisted, 60, "the cursor is handed to the caller for storage");

  // More messages arrive while the client is gone.
  for (let seq = 61; seq <= 65; seq += 1) log.push(row(seq));

  // Second life: a NEW object, only the persisted number survives.
  const second = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10, resumedFrom: persisted });
  const state = await second.start();
  assert.deepEqual(
    state.messages.map((m) => m.seq),
    [61, 62, 63, 64, 65],
    "exactly the missed rows — nothing replayed, nothing skipped",
  );
  assert.equal(state.cursor, 65);
  // And it did NOT read the tail: a resumed client asks "after".
  assert.equal(transport.calls.filter((c) => c.op === "page" && c.tail !== undefined).length, 1, "one tail read, from the first life");
});

test("2.3 with nothing missed, a resumed client shows an empty increment, not a replay", async () => {
  const log = [row(1), row(2), row(3)];
  const transport = fakeTransport(log);
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 10, resumedFrom: 3 });
  const state = await client.start();
  assert.deepEqual(state.messages, []);
  assert.equal(state.cursor, 3, "the cursor survives an empty resume");
});

test("2.3 a cursor from another room's log cannot rewind this one", async () => {
  const transport = fakeTransport([row(10), row(11)]);
  const client = new ZhiyuRoomClient({ transport, roomId: "r2", tailCount: 10, resumedFrom: 11 });
  const state = await client.start();
  assert.equal(state.cursor, 11);
  assert.deepEqual(state.messages, []);
});

// ── transport failures stay visible ───────────────────────────────────────

test("a transport failure is reported in state, not thrown at the caller", async () => {
  const client = new ZhiyuRoomClient({
    transport: {
      async page() {
        throw new Error("offline");
      },
      async increment() {
        throw new Error("offline");
      },
    },
    roomId: "r1",
  });
  const state = await client.start();
  assert.equal(state.error, "offline");
  assert.equal(state.loading, false);
  assert.deepEqual(state.messages, []);
});

test("an empty increment that advances the cursor is honoured (a hidden row)", async () => {
  // A private row we are not allowed to see still moves the server cursor. If
  // the client ignores it, it re-reads the same window forever.
  const client = new ZhiyuRoomClient({
    transport: {
      async page() {
        return { messages: [] };
      },
      async increment() {
        return { messages: [], cursor: 42 };
      },
    },
    roomId: "r1",
    resumedFrom: 10,
  });
  const state = await client.poll(0);
  assert.equal(state.cursor, 42);
  assert.deepEqual(state.messages, []);
});

// ── 2.4 no new runtime dependency ─────────────────────────────────────────

test("2.4 the core module adds no runtime dependency", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "packages/core/src/zhiyu-room-client.ts"), "utf8");
  const imports = [...src.matchAll(/^\s*import\s+.*?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], `core must stay dependency-free, found: ${imports.join(", ")}`);
  // And it must not reach for a platform global at module scope.
  assert.equal(/\bwindow\.|\bdocument\.|localStorage|Taro\.|require\(/.test(src), false);
});

test("2.4 the package manifest gains nothing", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "packages/core/package.json"), "utf8"));
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
  // React is the only thing this package is allowed to need (the store hooks).
  assert.deepEqual(deps.filter((d) => !["react", "react-dom", "zustand"].includes(d)), []);
});
