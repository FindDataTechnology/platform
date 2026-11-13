// The mobile halves of the long-recording plan (openspec:
// add-voice-capture-lane, task 5.4).
//
// "三端走同一份切片 + 重传实现" is only checkable if the clients can be run
// without a device. Both capture-upload modules therefore take an injected
// transport and a platform object and import no WeChat/Expo global at module
// scope — this file loads them straight into node, next to the shared module
// they both reach through @platform/core (mapped to packages/core below because
// node has no bundler alias).
//
// What is pinned, per client:
//   (a) 95s plans four slices 30/30/30/5, identical to the shared plan;
//   (b) one failed slice is retried by retryPending(), and only that slice;
//   (c) at CAPTURE_MAX_ATTEMPTS the slice is given up, never retried;
//   (d) a 202 `stopped` response stops further sends and is surfaced;
//   (e) the merged text is the segments joined in seq order (shared export).
//
//   node --test scripts/test-voice-capture-mobile.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const SLICES_FILE = path.join(ROOT, "packages/core/src/voice-capture-slices.ts");

// Both clients import `@platform/core` at runtime. Node has no tsconfig paths,
// so the bare specifier is resolved to the one module they actually use. This
// also proves the clients import the SHARED plan rather than a private copy.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@platform/core") {
      return { url: pathToFileURL(SLICES_FILE).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const core = await import(pathToFileURL(SLICES_FILE).href);

const CLIENTS = [
  { name: "miniapp", platform: "miniapp", file: path.join(ROOT, "miniapp/src/lib/capture-upload.ts") },
  { name: "app", platform: "app", file: path.join(ROOT, "app/src/lib/capture-upload.ts") },
];

const modules = new Map();
for (const client of CLIENTS) {
  modules.set(client.name, await import(pathToFileURL(client.file).href));
}

// ── stub transport ──────────────────────────────────────────────────────────

/**
 * A stand-in for Taro.request/uploadFile and fetch. It keeps the two facts the
 * uploader is allowed to rely on: the response status + JSON body, and the
 * multipart fields (seq/start_ms/duration_ms/file).
 */
function stubTransport({ failThrows = new Map(), stoppedFrom = null, segments = [] } = {}) {
  const calls = [];
  const attempts = new Map();

  const upload = async (req) => {
    calls.push({ ...req });
    if (req.op === "create") {
      return { status: 201, body: { capture: { id: "cap_test" } } };
    }
    if (req.op === "chunk") {
      if (stoppedFrom !== null && req.seq >= stoppedFrom) {
        return {
          status: 202,
          body: {
            chunk: { seq: req.seq, status: "pending", text: "", attempts: 0, hasAudio: true },
            stopped: "minutes",
            budget: { minutes: 10, minutesLimit: 10, usd: 0, usdLimit: 1, resetsAt: null },
          },
        };
      }
      const remaining = failThrows.get(req.seq) ?? 0;
      if (remaining > 0) {
        failThrows.set(req.seq, remaining - 1);
        attempts.set(req.seq, (attempts.get(req.seq) ?? 0) + 1);
        throw new Error("network down");
      }
      attempts.set(req.seq, (attempts.get(req.seq) ?? 0) + 1);
      return {
        status: 200,
        body: {
          chunk: {
            seq: req.seq,
            status: "done",
            text: `text-${req.seq}`,
            attempts: attempts.get(req.seq),
            hasAudio: false,
          },
          budget: { minutes: 1.5, minutesLimit: 10, usd: 0, usdLimit: 1, resetsAt: null },
        },
      };
    }
    if (req.op === "finish") {
      return { status: 200, body: { capture: { id: req.captureId, status: "finished" }, segments } };
    }
    if (req.op === "abandon") {
      return { status: 200, body: { ok: true } };
    }
    throw new Error(`unexpected op ${req.op}`);
  };

  return { upload, calls, chunkCalls: () => calls.filter((c) => c.op === "chunk") };
}

function makeUploader(client, transport) {
  const factory = modules.get(client.name).createCaptureUploader;
  assert.equal(typeof factory, "function", `${client.name} exports createCaptureUploader`);
  return factory({
    upload: transport.upload,
    platform: { name: client.platform, sliceMs: 30_000, now: () => 1_700_000_000_000 },
  });
}

// ── (a) the plan is the shared plan, on both clients ────────────────────────

test("a 95s recording plans 30/30/30/5 identically on the mini-program and the app", async () => {
  const expected = core.planSlices(95_000);
  assert.deepEqual(
    expected,
    [
      { seq: 0, startMs: 0, durationMs: 30_000 },
      { seq: 1, startMs: 30_000, durationMs: 30_000 },
      { seq: 2, startMs: 60_000, durationMs: 30_000 },
      { seq: 3, startMs: 90_000, durationMs: 5_000 },
    ],
    "the shared plan is 30/30/30/5",
  );

  const plans = [];
  for (const client of CLIENTS) {
    const transport = stubTransport();
    const uploader = makeUploader(client, transport);
    const state = await uploader.startCapture({ title: "meeting", totalMs: 95_000 });
    assert.equal(state.captureId, "cap_test", `${client.name} reads the capture id`);
    assert.deepEqual(state.slices, expected, `${client.name} uses the shared plan`);
    assert.deepEqual(
      state.chunks.map((c) => [c.seq, c.status, c.attempts]),
      [
        [0, "pending", 0],
        [1, "pending", 0],
        [2, "pending", 0],
        [3, "pending", 0],
      ],
      `${client.name} starts with four pending slices`,
    );
    plans.push(state.slices);
  }
  assert.deepEqual(plans[0], plans[1], "both clients plan byte-identically");
});

// ── (b) retry only the slice that failed ────────────────────────────────────

for (const client of CLIENTS) {
  test(`${client.name}: a failed slice is retried by retryPending(), and only that slice`, async () => {
    const transport = stubTransport({ failThrows: new Map([[1, 1]]) });
    const uploader = makeUploader(client, transport);
    await uploader.startCapture({ totalMs: 95_000 });

    for (let seq = 0; seq < 4; seq += 1) {
      const slice = core.planSlices(95_000)[seq];
      await uploader.uploadSlice(seq, slice.startMs, slice.durationMs, `/tmp/slice-${seq}.mp3`);
    }
    let state = uploader.getState();
    assert.equal(state.chunks.find((c) => c.seq === 1).status, "failed", "slice 1 failed");
    assert.equal(state.chunks.find((c) => c.seq === 1).attempts, 1);
    assert.deepEqual(core.pendingSlices(state.chunks), [1], "only slice 1 is retryable");

    const before = transport.chunkCalls().length;
    const resent = await uploader.retryPending();
    const after = transport.chunkCalls();
    assert.deepEqual(resent, [1], "retryPending reports exactly slice 1");

    const newCalls = after.slice(before);
    assert.equal(newCalls.length, 1, "exactly one new request");
    assert.equal(newCalls[0].seq, 1, "the re-sent slice is 1");
    assert.equal(newCalls[0].filePath, "/tmp/slice-1.mp3", "the retry reuses the stored file");
    assert.equal(newCalls[0].startMs, 30_000, "the retry keeps the original offset");

    state = uploader.getState();
    assert.equal(state.chunks.find((c) => c.seq === 1).status, "done", "the retry settled slice 1");
  });
}

// ── (c) the retry ceiling is the shared one ─────────────────────────────────

for (const client of CLIENTS) {
  test(`${client.name}: at CAPTURE_MAX_ATTEMPTS the slice is given up, not retried`, async () => {
    // Two thrown uploads: the first failure is retryable, the second hits the
    // shared ceiling (CAPTURE_MAX_ATTEMPTS = 2).
    const transport = stubTransport({ failThrows: new Map([[0, 2]]) });
    const uploader = makeUploader(client, transport);
    await uploader.startCapture({ totalMs: 30_000 });

    await uploader.uploadSlice(0, 0, 30_000, "/tmp/slice-0.mp3");
    assert.equal(uploader.getState().chunks[0].attempts, 1);

    const firstRetry = await uploader.retryPending();
    assert.deepEqual(firstRetry, [0], "one retry is allowed");

    const state = uploader.getState();
    const chunk = state.chunks.find((c) => c.seq === 0);
    assert.equal(chunk.attempts, core.CAPTURE_MAX_ATTEMPTS);
    assert.equal(chunk.status, "failed");
    assert.equal(chunk.retryable, false, "the shared ceiling marks it not retryable");
    assert.equal(core.sliceAction(chunk), "give-up", "the shared decision is give-up");

    const callsAtCeiling = transport.chunkCalls().length;
    assert.deepEqual(await uploader.retryPending(), [], "nothing is left in the retry queue");
    assert.equal(transport.chunkCalls().length, callsAtCeiling, "no third request was made");
  });
}

// ── (d) a 202 stopped response closes the gate ──────────────────────────────

for (const client of CLIENTS) {
  test(`${client.name}: a 202 stopped response stops further sends and is surfaced`, async () => {
    const transport = stubTransport({ stoppedFrom: 0 });
    const uploader = makeUploader(client, transport);
    await uploader.startCapture({ totalMs: 95_000 });

    const first = await uploader.uploadSlice(0, 0, 30_000, "/tmp/slice-0.mp3");
    assert.equal(first.ok, false);
    assert.equal(first.stopped, "minutes", "the gate is reported on the slice result");
    assert.equal(uploader.getState().stopped, "minutes", "the gate is in observable state");

    const callsAfterStop = transport.chunkCalls().length;
    const second = await uploader.uploadSlice(1, 30_000, 30_000, "/tmp/slice-1.mp3");
    assert.equal(second.skipped, true, "the client refuses to send while the gate is closed");
    assert.equal(second.stopped, "minutes");
    assert.equal(transport.chunkCalls().length, callsAfterStop, "no second request left the device");

    // Buffered-but-not-transcribed must not look retryable — re-sending would
    // only burn the user's network against a closed gate.
    assert.deepEqual(await uploader.retryPending(), []);
    assert.equal(transport.chunkCalls().length, callsAfterStop);
  });
}

// ── (e) the merged text is the ordered join ─────────────────────────────────

for (const client of CLIENTS) {
  test(`${client.name}: the final merged text joins segments in seq order`, async () => {
    // Deliberately out of order: the uploader must sort, not trust arrival.
    const transport = stubTransport({
      segments: [
        { seq: 2, startMs: 60_000, text: "丙" },
        { seq: 0, startMs: 0, text: "甲" },
        { seq: 1, startMs: 30_000, text: "  " },
        { seq: 3, startMs: 90_000, text: "丁" },
      ],
    });
    const uploader = makeUploader(client, transport);
    await uploader.startCapture({ totalMs: 95_000 });

    const state = await uploader.finishCapture();
    assert.equal(state.status, "finished");
    assert.deepEqual(
      state.segments.map((s) => s.startMs),
      [0, 60_000, 90_000],
      "segments are ordered by offset; a silent one contributes nothing",
    );
    const expected = core.exportCaptureText([
      { startMs: 0, text: "甲" },
      { startMs: 60_000, text: "丙" },
      { startMs: 90_000, text: "丁" },
    ]);
    assert.equal(state.text, expected, "the text is the shared export of the ordered join");
    assert.equal(state.text, "[00:00] 甲\n[01:00] 丙\n[01:30] 丁");
    assert.equal(state.progress.fraction, state.progress.total === 0 ? 0 : state.progress.fraction);
  });
}

// ── the modules are loadable without a device ───────────────────────────────

test("both capture-upload modules import in node with no WeChat/Expo global touched", () => {
  // No Taro/wx/expo global exists in this process: reaching this point without
  // a ReferenceError is the proof that neither module touched one at import.
  for (const client of CLIENTS) {
    const mod = modules.get(client.name);
    assert.equal(typeof mod.createCaptureUploader, "function", `${client.name} exports the factory`);
  }
  assert.equal(typeof globalThis.wx, "undefined");
  assert.equal(typeof globalThis.Taro, "undefined");
});
