// The browser's transport for the shared room state machine (openspec:
// add-zhiyu-mobile-clients, task 2.2).
//
// Web is the only client with a real stream, so this is the only event-driven
// transport — and it is the one that has to keep the same contract as the
// polling one or the shared state machine stops being shared. What is pinned
// here is that contract, not the page:
//
//   • `increment(after, wait)` resolves EARLY when a row arrives and resolves
//     EMPTY with the same cursor when the window closes;
//   • a reconnect replay (the server re-sends from our cursor) does not put the
//     same row in twice;
//   • overlay frames are not rows — they are seq-less and must never enter the
//     message list, or the cursor would jump to undefined;
//   • closing the transport resolves the waiter instead of leaving a poll
//     hanging forever on unmount.
//
//   node --test scripts/test-zhiyu-web-transport.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { createEventSourceTransport } = await import("../web/src/lib/zhiyu-room-transport.ts");
const { ZhiyuRoomClient } = await import("../packages/core/src/zhiyu-room-client.ts");

const row = (seq, content = `第 ${seq} 行`) => ({ seq, kind: "human", content });

/** A stand-in for `window.EventSource` that the test drives by hand. */
function fakeEventSource() {
  const opened = [];
  const instances = [];
  const factory = (url) => {
    opened.push(url);
    const listeners = {};
    const es = {
      url,
      onopen: null,
      onmessage: null,
      onerror: null,
      closed: false,
      addEventListener(type, fn) {
        // Expanded on purpose: `(listeners[type] ??= []).push(fn)` is the same
        // thing, but biome's noAssignInExpressions is right that a read that
        // also writes is a place a reader has to stop and think.
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      close() {
        es.closed = true;
      },
      // test-side drivers
      open() {
        es.onopen?.({});
      },
      emit(payload) {
        es.onmessage?.({ data: JSON.stringify(payload) });
      },
      overlay(payload) {
        for (const fn of listeners.overlay ?? []) fn({ data: JSON.stringify(payload) });
      },
      fail() {
        es.onerror?.({});
      },
    };
    instances.push(es);
    return es;
  };
  return { opened, instances, factory };
}

function fakeRequest(log) {
  const calls = [];
  return {
    calls,
    async request(p) {
      calls.push(p);
      const url = new URL(p, "http://x");
      const sorted = [...log].sort((a, b) => a.seq - b.seq);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const tail = url.searchParams.get("tail");
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      const messages =
        tail !== null
          ? sorted.slice(-Number(tail))
          : before !== null
            ? sorted.filter((m) => m.seq < Number(before)).slice(-limit)
            : sorted.filter((m) => m.seq > Number(after ?? 0)).slice(0, limit);
      return { ok: true, status: 200, json: async () => ({ messages }) };
    },
  };
}

// ── the window endpoints ──────────────────────────────────────────────────

test("the transport asks the documented window endpoints", async () => {
  const fake = fakeRequest([]);
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r 1", request: fake.request, eventSource: es.factory });
  await transport.page({ tail: 20 });
  await transport.page({ before: 7, limit: 10 });
  await transport.page({ after: 3, limit: 5 });
  assert.match(fake.calls[0], /^\/api\/zhiyu\/rooms\/r%201\/messages\?tail=20$/);
  assert.match(fake.calls[1], /before=7&limit=10/);
  assert.match(fake.calls[2], /after=3&limit=5/);
  transport.close();
});

test("the stream opens at the cursor the state machine gives it", async () => {
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest([]).request, eventSource: es.factory });
  await transport.page({ tail: 5 });
  const pending = transport.increment(0, 5);
  assert.equal(es.opened.length, 1);
  assert.match(es.opened[0], /\/api\/zhiyu\/rooms\/r1\/events$/);
  es.instances[0].emit(row(1));
  const out = await pending;
  assert.deepEqual(out.messages.map((m) => m.seq), [1]);
  assert.equal(out.cursor, 1);
  transport.close();
});

// ── the contract the polling transport also honours ───────────────────────

test("a row arriving on the stream wakes a waiting increment early", async () => {
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest([]).request, eventSource: es.factory });
  const started = Date.now();
  const pending = transport.increment(0, 5_000); // would wait 5s if nothing came
  setTimeout(() => es.instances[0].emit(row(9, "来了")), 40);
  const out = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `woke early (${elapsed}ms)`);
  assert.equal(out.messages.at(-1).content, "来了");
  assert.equal(out.cursor, 9);
  transport.close();
});

test("an empty window returns the same cursor instead of rewinding", async () => {
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest([]).request, eventSource: es.factory });
  const out = await transport.increment(41, 60);
  assert.deepEqual(out.messages, []);
  assert.equal(out.cursor, 41, "an empty increment must not move the cursor");
  transport.close();
});

test("a reconnect replay does not deliver the same row twice", async () => {
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest([]).request, eventSource: es.factory });
  const pending = transport.increment(0, 1_000);
  const stream = es.instances[0];
  stream.emit(row(5));
  await pending;
  // The server replays from our cursor on reconnect; seq 5 must be dropped.
  const second = transport.increment(5, 1_000);
  stream.emit(row(5));
  stream.emit(row(6));
  const out = await second;
  assert.deepEqual(out.messages.map((m) => m.seq), [6], "the replayed row is not a new row");
  assert.equal(out.cursor, 6);
  transport.close();
});

// ── overlays are not rows ─────────────────────────────────────────────────

test("overlay frames reach the page and never enter the message list", async () => {
  const es = fakeEventSource();
  const overlays = [];
  const transport = createEventSourceTransport({
    roomId: "r1",
    request: fakeRequest([]).request,
    eventSource: es.factory,
    onOverlay: (o) => overlays.push(o),
  });
  const pending = transport.increment(0, 60);
  es.instances[0].overlay({ kind: "delta", text: "思考中" });
  const out = await pending;
  assert.deepEqual(out.messages, [], "an overlay is not a message");
  assert.equal(out.cursor, 0);
  assert.deepEqual(overlays, [{ kind: "delta", text: "思考中" }]);
  transport.close();
});

test("connection changes are reported to the page", () => {
  const es = fakeEventSource();
  const seen = [];
  const transport = createEventSourceTransport({
    roomId: "r1",
    request: fakeRequest([]).request,
    eventSource: es.factory,
    onConnectionChange: (open) => seen.push(open),
  });
  void transport.increment(0, 10);
  es.instances[0].open();
  es.instances[0].fail();
  assert.deepEqual(seen, [true, false]);
  transport.close();
});

// ── closing ───────────────────────────────────────────────────────────────

test("close() resolves a pending increment and drops the connection", async () => {
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest([]).request, eventSource: es.factory });
  const pending = transport.increment(7, 5_000);
  const started = Date.now();
  transport.close();
  const out = await pending;
  assert.ok(Date.now() - started < 1_000, "closing must not leave a poll hanging");
  assert.deepEqual(out.messages, []);
  assert.equal(out.cursor, 7);
  assert.equal(es.instances[0].closed, true);
});

// ── the state machine over this transport ─────────────────────────────────

test("the shared state machine opens at the tail over this transport, not at row 1", async () => {
  const log = Array.from({ length: 300 }, (_, i) => row(i + 1));
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest(log).request, eventSource: es.factory });
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 50, pageSize: 50 });
  const state = await client.start();
  assert.equal(state.messages.length, 50);
  assert.equal(state.messages[0].seq, 251, "the tail window, not the whole room");
  assert.equal(state.cursor, 300);
  assert.equal(state.hasOlder, true);
  transport.close();
});

test("the state machine pages back over this transport", async () => {
  const log = Array.from({ length: 120 }, (_, i) => row(i + 1));
  const es = fakeEventSource();
  const transport = createEventSourceTransport({ roomId: "r1", request: fakeRequest(log).request, eventSource: es.factory });
  const client = new ZhiyuRoomClient({ transport, roomId: "r1", tailCount: 20, pageSize: 20 });
  await client.start();
  let state = await client.loadOlder();
  assert.equal(state.messages[0].seq, 81);
  assert.equal(state.cursor, 120, "paging back never moves the cursor");
  while (state.hasOlder) state = await client.loadOlder();
  assert.equal(state.messages[0].seq, 1);
  assert.equal(state.cursor, 120);
  transport.close();
});

test("2.2 the adapter is DOM-free at module scope (no window/EventSource default)", () => {
  const raw = fs.readFileSync(path.resolve(import.meta.dirname, "..", "web/src/lib/zhiyu-room-transport.ts"), "utf8");
  // Strip comments first: this file TALKS about `window.EventSource` in its
  // header, and a scan that reads prose as code fails on its own documentation.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // EventSource is INJECTED — a module-level `new EventSource` cannot be tested
  // and cannot run in the mini-program bundle.
  assert.equal(/^\s*(?:const|let|var)\s+\w+\s*=\s*new\s+EventSource/m.test(src), false);
  assert.equal(/window\.EventSource/.test(src), false, "the browser global is passed in by the page, not read here");
  // The only core import is type-only, so this file adds no runtime dependency.
  const valueImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["'](.+?)["']/gm)].map((m) => m[1]);
  assert.deepEqual(valueImports, [], `no runtime import allowed, found: ${valueImports.join(", ")}`);
});
