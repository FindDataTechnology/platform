// Cross-client recorder parity (openspec: add-voice-input-mobile, task 3.3).
//
// Task 3.3 asks for "the same assertions run against both adapters", so this
// file imports BOTH the mini-program adapter and the app adapter and drives
// each with the same table. If a future edit lets one client drift (say the app
// starts uploading on cancel), exactly one row goes red and names the client.
//
// The four invariants every client must share, because they are what the user
// and the spec actually observe:
//   1. a denied permission answers false, never throws;
//   2. a normal take carries a usable file name;
//   3. "nothing was captured" is reported as no-usable-take;
//   4. cancel while a take is landing never reaches upload (via the machine).

import { test } from "node:test";
import assert from "node:assert/strict";

const { VoiceRecorder } = await import("../packages/core/src/voice-recorder.ts");
const { createMiniRecorderAdapter } = await import("../miniapp/src/lib/recorder.ts");
const { createExpoRecorderAdapter } = await import("../app/src/lib/recorder.ts");

// ── mini-program client ─────────────────────────────────────────────────────

function miniClient({ permission = true, fileSize = 1024 } = {}) {
  const handlers = { start: [], stop: [], error: [] };
  const manager = {
    start() {
      queueMicrotask(() => {
        for (const cb of handlers.start) cb();
      });
    },
    stop() {},
    onStart(cb) {
      handlers.start = [cb];
    },
    onStop(cb) {
      handlers.stop = [cb];
    },
    onError(cb) {
      handlers.error = [cb];
    },
    /** Deliver the finished take (the platform does this async). */
    deliver() {
      queueMicrotask(() => {
        for (const cb of handlers.stop) cb({ tempFilePath: "wxfile://tmp/rec.mp3", fileSize, duration: 1200 });
      });
    },
  };
  const adapter = createMiniRecorderAdapter({
    isSupported: () => true,
    getRecorderManager: () => manager,
    getAuthSetting: async () => (permission ? true : false),
    requestAuth: async () => permission,
  });
  return { adapter, manager };
}

// ── app client ──────────────────────────────────────────────────────────────

function appClient({ permission = true, uri = "file:///tmp/rec.m4a" } = {}) {
  const recorder = {
    uri,
    prepareToRecordAsync: async () => {},
    record: () => {},
    stop: async () => {},
  };
  const adapter = createExpoRecorderAdapter({
    recorder,
    requestPermission: async () => permission,
  });
  return { adapter, recorder };
}

// ── the shared table ────────────────────────────────────────────────────────

const CLIENTS = [
  {
    name: "mini-program",
    make: (opts) => miniClient(opts),
    start: async (c) => {
      await c.adapter.requestPermission();
      await c.adapter.start();
    },
    finish: (c) => c.manager.deliver(),
  },
  {
    name: "app",
    make: (opts) => appClient(opts),
    start: async (c) => {
      await c.adapter.requestPermission();
      await c.adapter.start();
    },
    finish: () => {},
  },
];

for (const client of CLIENTS) {
  test(`[${client.name}] a denied permission answers false and never throws`, async () => {
    const c = client.make({ permission: false });
    assert.equal(await c.adapter.requestPermission(), false);
  });

  test(`[${client.name}] a normal take carries a usable file name`, async () => {
    const c = client.make();
    await client.start(c);
    const stopping = c.adapter.stop();
    client.finish(c);
    const take = await stopping;
    assert.ok(take, "a real capture must produce a take");
    assert.match(take.fileName, /\.(mp3|m4a|wav|aac)$/i);
    assert.notEqual(take.empty, true);
  });

  test(`[${client.name}] nothing captured is no usable take`, async () => {
    const c = client.make({ fileSize: 0, uri: null });
    await client.start(c);
    const stopping = c.adapter.stop();
    client.finish(c);
    const take = await stopping;
    // Either shape is fine — the machine treats both as "return to idle".
    assert.ok(take === null || take.empty === true, "an empty capture must not look like a usable take");
  });

  test(`[${client.name}] cancel while a take is landing never uploads`, async () => {
    const c = client.make();
    await client.start(c);
    const uploads = [];
    const machine = new VoiceRecorder({
      adapter: c.adapter,
      upload: async (take) => {
        uploads.push(take);
        return { text: "should not happen" };
      },
      insert: () => {},
    });
    // Drive the machine (not the adapter) into a take, then cancel it.
    await machine.start();
    const stopping = machine.stop();
    await machine.cancel();
    client.finish(c);
    await stopping;
    assert.equal(uploads.length, 0, "a cancelled take must never reach the network");
  });
}

// ── the two clients must agree on the same transcript rule ─────────────────

test("both clients append transcripts through the shared rule", async () => {
  const { composeTranscript } = await import("../packages/core/src/voice-recorder.ts");
  assert.equal(composeTranscript("", "你好"), "你好");
  assert.equal(composeTranscript("已有", "你好"), "已有 你好");
  assert.equal(composeTranscript("已有", "  "), null);
});
