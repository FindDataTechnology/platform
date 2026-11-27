// The polling ladder and lifecycle (openspec: add-zhiyu-mobile-clients, 3.2 /
// 4.3).
//
// Both mobile clients poll, and the two failures worth pinning are the ones that
// look fine in a demo:
//   • a client that retries at a fixed rate during a three-minute outage — it
//     either hammers the gateway or (worse) gives up and never comes back;
//   • a client that treats "returned to the foreground" as one increment, which
//     leaves a hole in the middle of the room that nothing later can fill.
//
// The scheduler and the request are both injected, so the whole three minutes
// runs in microseconds and the assertions are about ORDER and CONTENT, not about
// waiting.
//
//   node --test scripts/test-zhiyu-poll-ladder.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { PollDriver, createPollingTransport, nextPollDelay, POLL_BACKOFF_MS } = await import(
  "../packages/core/src/zhiyu-poll.ts"
);
const { ZhiyuRoomClient } = await import("../packages/core/src/zhiyu-room-client.ts");

/** Build the pair the way every client will: shared transport + shared client. */
function driverFor({ request, tailCount = 10, pageSize = 10, resumedFrom = null, scheduler, onCursor }) {
  const client = new ZhiyuRoomClient({
    transport: createPollingTransport({ roomId: "r1", request }),
    roomId: "r1",
    tailCount,
    pageSize,
    resumedFrom,
    onCursor,
  });
  return new PollDriver({ client, scheduler, onState: undefined });
}

const row = (seq) => ({ seq, kind: "human", content: `第 ${seq} 行` });

/** A request that reads a mutable log, with a switchable failure mode. */
function fakeRequest(log, control) {
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });
  return {
    calls,
    async request(p) {
      calls.push(p);
      if (control.fail) throw new Error("offline");
      const url = new URL(p, "http://x");
      const sorted = [...log].sort((a, b) => a.seq - b.seq);
      if (url.pathname.endsWith("/stream")) {
        const after = Number(url.searchParams.get("after") ?? 0);
        const page = sorted.filter((m) => m.seq > after).slice(0, control.pageCap ?? 500);
        const cursor = page.length ? page[page.length - 1].seq : after;
        return ok({ messages: page, cursor });
      }
      const tail = url.searchParams.get("tail");
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (tail !== null) return ok({ messages: sorted.slice(-Math.min(Number(tail), limit)) });
      if (before !== null) return ok({ messages: sorted.filter((m) => m.seq < Number(before)).slice(-limit) });
      return ok({ messages: sorted.filter((m) => m.seq > Number(after ?? 0)).slice(0, limit) });
    },
  };
}

/** A scheduler that records the delay instead of waiting for it. */
function fakeScheduler() {
  const queued = [];
  return {
    queued,
    schedule(fn, ms) {
      queued.push({ fn, ms });
      return () => {
        const i = queued.findIndex((q) => q.fn === fn);
        if (i >= 0) queued.splice(i, 1);
      };
    },
    /** Run the next queued tick (if any) and let its follow-up work land. */
    async runNext() {
      const next = queued.shift();
      if (!next) return null;
      // The driver's timer body is `void this.tick().then(scheduleNext)`: the
      // callback returns BEFORE the next timer is queued. Draining a macrotask
      // (the fake request is async) is what makes "one tick" observable as one
      // step — without it the queue still looks empty and a loop stops early.
      await next.fn();
      await new Promise((r) => setTimeout(r, 0));
      return next.ms;
    },
  };
}

// ── the ladder itself ─────────────────────────────────────────────────────

test("the ladder is 1s → 3s, capped, and a success resets it", () => {
  assert.deepEqual([...POLL_BACKOFF_MS], [1000, 3000]);
  assert.equal(nextPollDelay(0), 0, "the first attempt is immediate");
  assert.equal(nextPollDelay(1), 1000);
  assert.equal(nextPollDelay(2), 3000);
  assert.equal(nextPollDelay(3), 3000, "capped, not exponential forever");
  assert.equal(nextPollDelay(99), 3000);
  assert.equal(nextPollDelay(-5), 0);
  assert.equal(nextPollDelay(Number.NaN), 0);
});

// ── 3.2 three minutes offline, then recovery ──────────────────────────────

test("3.2 a three-minute outage backs off to 3s and recovers without losing or repeating a row", async () => {
  const log = Array.from({ length: 20 }, (_, i) => row(i + 1));
  const control = { fail: false, pageCap: 500 };
  const fake = fakeRequest(log, control);
  const scheduler = fakeScheduler();
  const cursorWrites = [];
  const driver = driverFor({
    request: fake.request,
    tailCount: 10,
    pageSize: 10,
    scheduler: scheduler.schedule,
    onCursor: (seq) => cursorWrites.push(seq),
  });

  const started = await driver.start();
  assert.equal(started.cursor, 20);

  // ── the outage ──
  control.fail = true;
  const delays = [];
  for (let i = 0; i < 60; i += 1) {
    const waited = await scheduler.runNext();
    if (waited === null) break;
    delays.push(waited);
    if (delays.length >= 6) break;
  }
  assert.deepEqual(delays.slice(0, 4), [0, 1000, 3000, 3000], "immediate, then the ladder, then the cap");
  assert.equal(driver.failureCount, 6);

  // ── messages arrive while we are offline ──
  for (let seq = 21; seq <= 35; seq += 1) log.push(row(seq));

  // ── recovery: the next attempt succeeds and the backoff resets ──
  control.fail = false;
  await scheduler.runNext();
  assert.equal(driver.failureCount, 0, "one success clears the ladder");

  const state = driver.client.state_();
  assert.equal(state.cursor, 35, "caught up to the newest row, not just one page of it");
  const seqs = state.messages.map((m) => m.seq);
  assert.equal(new Set(seqs).size, seqs.length, "no row twice");
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], "strictly increasing, no hole");
  assert.ok(seqs.includes(21) && seqs.includes(35), "both edges of the outage window arrived");
  driver.stop();
});

// ── 4.3 background pause / foreground catch-up ────────────────────────────

test("4.3 paused means silent: no request leaves the device", async () => {
  const log = [row(1), row(2)];
  const control = { fail: false };
  const fake = fakeRequest(log, control);
  const scheduler = fakeScheduler();
  const driver = driverFor({ request: fake.request, tailCount: 10, scheduler: scheduler.schedule });
  await driver.start();
  const before = fake.calls.length;

  driver.pause();
  assert.equal(driver.isPaused(), true);
  assert.equal(scheduler.queued.length, 0, "pausing cancels the pending tick");
  const ticked = await driver.tick();
  assert.deepEqual(ticked.messages.map((m) => m.seq), [1, 2], "a tick while paused is a no-op");
  assert.equal(fake.calls.length, before, "and it issued no request");
  driver.stop();
});

test("4.3 five minutes in the background costs one catch-up and loses nothing", async () => {
  const log = Array.from({ length: 5 }, (_, i) => row(i + 1));
  const control = { fail: false, pageCap: 20 };
  const fake = fakeRequest(log, control);
  const scheduler = fakeScheduler();
  const driver = driverFor({ request: fake.request, tailCount: 5, pageSize: 20, scheduler: scheduler.schedule });
  await driver.start();
  assert.equal(driver.client.state_().cursor, 5);

  driver.pause();
  // The room keeps moving while the phone is in a pocket — more than one page.
  for (let seq = 6; seq <= 60; seq += 1) log.push(row(seq));

  const resumed = await driver.resume();
  assert.equal(resumed.cursor, 60);
  const seqs = resumed.messages.map((m) => m.seq);
  assert.equal(seqs[0], 1, "what we had is still there");
  assert.deepEqual(
    seqs,
    Array.from({ length: 60 }, (_, i) => i + 1),
    "contiguous: a single increment would have left a hole around 25",
  );
  driver.stop();
});

test("4.3 resuming from a persisted cursor does not replay the room", async () => {
  const log = Array.from({ length: 40 }, (_, i) => row(i + 1));
  const control = { fail: false };
  const fake = fakeRequest(log, control);
  const scheduler = fakeScheduler();
  const driver = driverFor({ request: fake.request, tailCount: 10, resumedFrom: 40, scheduler: scheduler.schedule });
  const state = await driver.start();
  assert.deepEqual(state.messages, [], "nothing missed, so nothing to show");
  assert.equal(state.cursor, 40);
  driver.stop();
});

// ── the transport's own contract ──────────────────────────────────────────

test("the transport never falls back to `after` when the server omits a cursor", async () => {
  // Falling back to `after` would re-read the same window forever.
  const transport = createPollingTransport({
    roomId: "r1",
    request: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [row(7), row(9)] }) }),
  });
  const out = await transport.increment(3, 0);
  assert.equal(out.cursor, 9, "the newest row we were handed");

  const empty = createPollingTransport({
    roomId: "r1",
    request: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [] }) }),
  });
  const none = await empty.increment(3, 0);
  assert.equal(none.cursor, 3, "an empty body keeps the cursor where it was");
});

test("the transport asks the documented endpoints", async () => {
  const seen = [];
  const transport = createPollingTransport({
    roomId: "room/with space",
    request: async (p) => {
      seen.push(p);
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ messages: [], cursor: 0 }) };
    },
  });
  await transport.page({ tail: 20 });
  await transport.page({ before: 5, limit: 10 });
  await transport.increment(12, 3000);
  assert.match(seen[0], /\/api\/zhiyu\/rooms\/room%2Fwith%20space\/messages\?tail=20/);
  assert.match(seen[1], /before=5&limit=10/);
  assert.match(seen[2], /\/stream\?after=12&wait=3000/);
});

test("an HTTP failure surfaces as a thrown error, so the ladder sees it", async () => {
  const transport = createPollingTransport({
    roomId: "r1",
    request: async () => ({ ok: false, status: 503, statusText: "Unavailable", json: async () => ({}) }),
  });
  await assert.rejects(() => transport.increment(0, 0), /stream_503/);
});

// ── the module stays importable and dependency-free ───────────────────────

test("the module carries no runtime import (type-only is fine)", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "packages/core/src/zhiyu-poll.ts"), "utf8");
  const valueImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
  assert.deepEqual(valueImports, [], `no runtime import allowed, found: ${valueImports.join(", ")}`);
  assert.equal(/\bwindow\.|\bdocument\.|localStorage|Taro\./.test(src), false, "no platform global at module scope");
});
