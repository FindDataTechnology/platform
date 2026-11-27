// Unit tests for the shared core's WsClient reconnect state machine
// (openspec: add-miniprogram-client, task 2.3).
//
// Runs under `npm run test:unit` (node --test scripts/test-*.mjs); the .ts
// import relies on Node's native type stripping, which the repo's engines
// (>=22) guarantee.

import test from "node:test";
import assert from "node:assert/strict";
import { WsClient } from "../packages/core/src/ws/client.ts";

// A SocketFactory that records every socket it mints and lets the test drive
// lifecycle by hand (open/message/close are the WsClient's callbacks).
function fakeWorld() {
  const sockets = [];
  const factory = (url) => {
    const handlers = {};
    const socket = {
      url,
      sent: [],
      send: (d) => socket.sent.push(d),
      close: () => handlers.onClose?.(),
      setHandlers: (h) => Object.assign(handlers, h),
      fireOpen: () => handlers.onOpen?.(),
      fireMessage: (d) => handlers.onMessage?.(d),
      fireClose: () => handlers.onClose?.(),
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

// 30s ceiling * 1.25 max jitter — any legal backoff delay is ≤ this.
const ANY_LEGAL_DELAY_MS = 30_000 * 1.25;

function makeClient(factory, overrides = {}) {
  const seen = { status: [], messages: [], opens: 0 };
  const client = new WsClient({
    url: () => "ws://test/",
    factory,
    onStatus: (s) => seen.status.push(s),
    onMessage: (m) => seen.messages.push(m),
    onOpen: () => seen.opens++,
    ...overrides,
  });
  return { client, seen };
}

test("connect reports status, replays open, parses messages", () => {
  const world = fakeWorld();
  const { client, seen } = makeClient(world.factory);
  client.connect();
  assert.equal(seen.status.at(-1), "connecting");

  world.sockets[0].fireOpen();
  assert.equal(seen.status.at(-1), "connected");
  assert.equal(seen.opens, 1);

  world.sockets[0].fireMessage('{"type":"done"}');
  assert.deepEqual(seen.messages, [{ type: "done" }]);

  // Bad JSON is logged, never thrown into the message handler.
  world.sockets[0].fireMessage("{not json");
  assert.equal(seen.messages.length, 1);

  client.send('{"type":"prompt","text":"hi"}');
  assert.deepEqual(world.sockets[0].sent, ['{"type":"prompt","text":"hi"}']);
});

test("retry budget: 20 reconnects then silence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = (ms) => t.mock.timers.tick(ms);
  const world = fakeWorld();
  const { client } = makeClient(world.factory);
  client.connect();

  for (let i = 0; i < 20; i++) {
    world.sockets.at(-1).fireClose();
    tick(ANY_LEGAL_DELAY_MS);
  }
  // Budget spent: 1 initial + 20 retries.
  assert.equal(world.sockets.length, 21);

  // No further timers fire anything new.
  tick(ANY_LEGAL_DELAY_MS * 100);
  assert.equal(world.sockets.length, 21);
  client.close();
});

test("a successful open resets the retry budget", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = (ms) => t.mock.timers.tick(ms);
  const world = fakeWorld();
  const { client } = makeClient(world.factory);
  client.connect();

  // Burn 10 attempts, then succeed once — budget resets to 0.
  for (let i = 0; i < 10; i++) {
    world.sockets.at(-1).fireClose();
    tick(ANY_LEGAL_DELAY_MS);
  }
  world.sockets.at(-1).fireOpen();

  // 25 more closes (more than the original 20-attempt budget) still
  // reconnect, because the open reset the counter.
  for (let i = 0; i < 25; i++) {
    world.sockets.at(-1).fireClose();
    tick(ANY_LEGAL_DELAY_MS);
  }
  assert.ok(world.sockets.length >= 30);
  client.close();
});

test("reconnectNow bypasses the armed backoff timer and resets the budget", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = fakeWorld();
  const { client } = makeClient(world.factory);
  client.connect();

  // Arm the backoff (attempt=1, timer pending)...
  world.sockets.at(-1).fireClose();
  assert.equal(world.sockets.length, 1);

  // ...then reconnect NOW: no tick needed, a fresh socket appears.
  client.reconnectNow();
  assert.equal(world.sockets.length, 2);

  // Budget was reset by reconnectNow: a full 20 closes still reconnect.
  for (let i = 0; i < 20; i++) {
    world.sockets.at(-1).fireClose();
    t.mock.timers.tick(ANY_LEGAL_DELAY_MS);
  }
  assert.equal(world.sockets.length, 22);
  client.close();
});

test("reconnectNow detaches the superseded socket — its late onClose spawns nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = fakeWorld();
  const { client } = makeClient(world.factory);
  client.connect();

  // Arm the backoff, then reconnect immediately: socket #1 is replaced (and
  // detached) by socket #2.
  world.sockets[0].fireClose();
  client.reconnectNow();
  assert.equal(world.sockets.length, 2);

  // Socket #1's onClose arrives asynchronously AFTER the replacement — with
  // the server broadcasting to every socket, a second live connection would
  // double every event. Detachment must make this a no-op.
  world.sockets[0].fireClose();
  world.sockets[0].fireOpen();
  t.mock.timers.tick(ANY_LEGAL_DELAY_MS * 100);
  assert.equal(world.sockets.length, 2, "no third socket may appear");
  client.close();
});

test("close() is final — no reconnection afterwards", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = fakeWorld();
  const { client } = makeClient(world.factory);
  client.connect();
  const count = world.sockets.length;

  client.close();
  t.mock.timers.tick(ANY_LEGAL_DELAY_MS * 100);
  assert.equal(world.sockets.length, count);
});
