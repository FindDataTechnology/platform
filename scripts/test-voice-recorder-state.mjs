// Voice recorder state machine (openspec: add-voice-input-mobile, task 1.1).
//
// The machine is the only place the five phases and their side effects exist;
// three clients plug adapters into it. Every invariant below is one the spec
// pins, so this file doubles as the behavioural contract for the adapters:
//
//   • cancel never uploads, even when the artifact lands afterwards;
//   • an empty take never leaves the device;
//   • start() during transcription is a no-op, not an error;
//   • a preflight rejection never reaches the network;
//   • illegal transitions neither throw nor produce side effects.

import { test } from "node:test";
import assert from "node:assert/strict";

const { VoiceRecorder } = await import("../packages/core/src/voice-recorder.ts");

/** A scripted adapter: records calls, lets a test decide what stop() yields. */
function fakeAdapter({ supported = true, permission = true, take = null } = {}) {
  const calls = [];
  let pending = take === null ? null : { ...take };
  return {
    calls,
    setTake(next) {
      pending = next;
    },
    isSupported: () => supported,
    requestPermission: async () => {
      calls.push("requestPermission");
      return permission;
    },
    start: async () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
      return pending;
    },
    cancel: async () => {
      calls.push("cancel");
    },
    count: (name) => calls.filter((c) => c === name).length,
  };
}

function harness(overrides = {}) {
  const adapter = overrides.adapter ?? fakeAdapter();
  const uploads = [];
  const inserted = [];
  const phases = [];
  const recorder = new VoiceRecorder({
    adapter,
    upload: async (take) => {
      uploads.push(take);
      if (overrides.uploadThrows) throw overrides.uploadThrows;
      return { text: overrides.text ?? "hello world" };
    },
    insert: (text) => inserted.push(text),
    preflight: overrides.preflight,
    autoStopMs: overrides.autoStopMs,
    onPhase: (phase) => phases.push(phase),
  });
  return { adapter, recorder, uploads, inserted, phases };
}

const TAKE = { artifact: {}, fileName: "recording.webm", durationMs: 1200 };

test("start → requesting → recording", async () => {
  const { recorder, adapter, phases } = harness();
  await recorder.start();
  assert.equal(recorder.phase(), "recording");
  assert.deepEqual(phases, ["requesting", "recording"]);
  assert.equal(adapter.count("requestPermission"), 1);
  assert.equal(adapter.count("start"), 1);
});

test("permission denied lands in error and never starts the recorder", async () => {
  const adapter = fakeAdapter({ permission: false });
  const { recorder } = harness({ adapter });
  await recorder.start();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure()?.code, "permission_denied");
  assert.equal(adapter.count("start"), 0);
});

test("unsupported platform reports recorder_failed without prompting", async () => {
  const adapter = fakeAdapter({ supported: false });
  const { recorder } = harness({ adapter });
  await recorder.start();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure()?.code, "recorder_failed");
  assert.equal(adapter.count("requestPermission"), 0);
});

test("stop → transcribing → idle with the transcript inserted once", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads, inserted, phases } = harness({ adapter });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 1);
  assert.deepEqual(inserted, ["hello world"]);
  assert.deepEqual(phases, ["requesting", "recording", "transcribing", "idle"]);
});

test("an empty take returns to idle without any upload", async () => {
  const adapter = fakeAdapter({ take: { ...TAKE, empty: true } });
  const { recorder, uploads } = harness({ adapter });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 0);
});

test("a null take (nothing captured) returns to idle without upload", async () => {
  const adapter = fakeAdapter({ take: null });
  const { recorder, uploads } = harness({ adapter });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 0);
});

test("cancel during recording never uploads, even when the artifact lands later", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads, inserted } = harness({ adapter });
  await recorder.start();
  const inFlight = recorder.stop(); // adapter.stop() is about to yield a real take
  await recorder.cancel(); // user swipes away before it resolves
  await inFlight;
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 0, "a cancelled take must not reach the network");
  assert.equal(inserted.length, 0);
});

test("cancel during requesting ignores a late permission grant", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const adapter = {
    isSupported: () => true,
    requestPermission: async () => {
      calls.push("requestPermission");
      await gate;
      return true;
    },
    start: async () => calls.push("start"),
    stop: async () => null,
    cancel: async () => calls.push("cancel"),
  };
  const recorder = new VoiceRecorder({ adapter, upload: async () => ({ text: "x" }), insert: () => {} });
  const starting = recorder.start();
  await recorder.cancel();
  release();
  await starting;
  assert.equal(recorder.phase(), "idle");
  assert.equal(calls.filter((c) => c === "start").length, 0, "a cancelled request must not begin recording");
});

test("start() while transcribing is a silent no-op", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  let releaseUpload;
  const gate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const recorder = new VoiceRecorder({
    adapter,
    upload: async () => {
      await gate;
      return { text: "late" };
    },
    insert: () => {},
  });
  await recorder.start();
  const stopping = recorder.stop();
  assert.equal(recorder.phase(), "transcribing");
  await recorder.start(); // must not queue a second take
  assert.equal(recorder.phase(), "transcribing");
  assert.equal(adapter.count("start"), 1);
  releaseUpload();
  await stopping;
  assert.equal(recorder.phase(), "idle");
});

test("preflight rejection fails locally and never uploads", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads } = harness({
    adapter,
    preflight: () => ({ ok: false, reason: "录音超过 25 MB 上限" }),
  });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure()?.code, "local_rejected");
  assert.equal(recorder.failure()?.message, "录音超过 25 MB 上限");
  assert.equal(uploads.length, 0);
});

test("preflight throw is treated as a local rejection", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads } = harness({
    adapter,
    preflight: () => {
      throw new Error("boom");
    },
  });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.failure()?.code, "local_rejected");
  assert.equal(uploads.length, 0);
});

test("upload failure surfaces the upstream message and the connect pointer", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const err = Object.assign(new Error("语音服务未配置凭据"), { connect: { panel: "ciyuan-account" } });
  const { recorder } = harness({ adapter, uploadThrows: err });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure()?.code, "upload_failed");
  assert.equal(recorder.failure()?.message, "语音服务未配置凭据");
  assert.deepEqual(recorder.failure()?.connect, { panel: "ciyuan-account" });
});

test("a whitespace-only transcript inserts nothing but returns to idle", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, inserted } = harness({ adapter, text: "   \n\t " });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.deepEqual(inserted, []);
});

test("stop() outside a recording is a no-op", async () => {
  const { recorder, adapter, uploads } = harness();
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.equal(adapter.count("stop"), 0);
  assert.equal(uploads.length, 0);
});

test("double stop never uploads twice", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads } = harness({ adapter });
  await recorder.start();
  await Promise.all([recorder.stop(), recorder.stop()]);
  assert.equal(uploads.length, 1, "the second stop must be a no-op, not a second upload");
});

test("autoStop ends the take without user input", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  const { recorder, uploads } = harness({ adapter, autoStopMs: 10 });
  await recorder.start();
  assert.equal(recorder.phase(), "recording");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 1);
});

test("markInterrupted only applies to a transcription in flight", async () => {
  const adapter = fakeAdapter({ take: TAKE });
  let releaseUpload;
  const gate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const recorder = new VoiceRecorder({
    adapter,
    upload: async () => {
      await gate;
      return { text: "too late" };
    },
    insert: () => {},
  });

  recorder.markInterrupted(); // idle: no-op
  assert.equal(recorder.phase(), "idle");

  await recorder.start();
  const stopping = recorder.stop();
  assert.equal(recorder.phase(), "transcribing");
  recorder.markInterrupted();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure()?.code, "interrupted");

  releaseUpload();
  await stopping;
  assert.equal(recorder.phase(), "error", "a late transcript must not overwrite the interrupted state");
});

test("dismissError returns to idle and clears the failure", async () => {
  const adapter = fakeAdapter({ permission: false });
  const { recorder } = harness({ adapter });
  await recorder.start();
  assert.equal(recorder.phase(), "error");
  recorder.dismissError();
  assert.equal(recorder.phase(), "idle");
  assert.equal(recorder.failure(), null);
});

test("retry after an error is allowed (error is not terminal)", async () => {
  const adapter = fakeAdapter({ permission: false });
  const { recorder } = harness({ adapter });
  await recorder.start();
  assert.equal(recorder.phase(), "error");
  adapter.requestPermission = async () => true;
  adapter.stop = async () => TAKE;
  await recorder.start();
  assert.equal(recorder.phase(), "recording");
});

test("subscribers see every transition and can unsubscribe", async () => {
  const { recorder } = harness();
  const seen = [];
  const off = recorder.subscribe((phase) => seen.push(phase));
  await recorder.start();
  off();
  await recorder.cancel();
  assert.deepEqual(seen, ["requesting", "recording"]);
});

// ── upload-ceiling pre-flight (task 4.1) ───────────────────────────────────

const { VOICE_MAX_UPLOAD_BYTES, estimateVoiceBytes, voiceFitsUpload } = await import(
  "../packages/core/src/voice-recorder.ts"
);

// Two hours at 48 kbps ≈ 41 MB. One hour at 48 kbps is only ~20.6 MB — it FITS,
// which is exactly the arithmetic mistake that made the first version of this
// test pass a take straight through to upload.
test("a two-hour 48 kbps take is estimated above the 25 MB ceiling", () => {
  const bytes = estimateVoiceBytes(2 * 60 * 60 * 1000, 48_000);
  assert.ok(bytes > VOICE_MAX_UPLOAD_BYTES, `expected > 25MB, got ${bytes}`);
  assert.equal(voiceFitsUpload(2 * 60 * 60 * 1000, 48_000), false);
});

test("a ten-minute 48 kbps take still fits", () => {
  assert.equal(voiceFitsUpload(10 * 60 * 1000, 48_000), true);
});

test("a zero or nonsense duration estimates zero bytes", () => {
  assert.equal(estimateVoiceBytes(0, 48_000), 0);
  assert.equal(estimateVoiceBytes(Number.NaN, 48_000), 0);
  assert.equal(estimateVoiceBytes(1000, 0), 0);
});

test("a pre-flight rejection never reaches the network (machine level)", async () => {
  const adapter = {
    isSupported: () => true,
    requestPermission: async () => true,
    start: async () => {},
    stop: async () => ({ artifact: {}, fileName: "x.mp3", durationMs: 2 * 60 * 60 * 1000 }),
    cancel: async () => {},
  };
  const uploads = [];
  const recorder = new VoiceRecorder({
    adapter,
    upload: async (take) => {
      uploads.push(take);
      return { text: "nope" };
    },
    insert: () => {},
    preflight: (take) =>
      voiceFitsUpload(take.durationMs, 48_000) ? { ok: true } : { ok: false, reason: "录音超过 25 MB 上限" },
  });
  await recorder.start();
  await recorder.stop();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure().code, "local_rejected");
  assert.match(recorder.failure().message, /25 MB/);
  assert.equal(uploads.length, 0, "an over-limit take must not be uploaded");
});
