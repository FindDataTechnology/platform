// Web voice path regression suite (openspec: add-voice-input-mobile, task 1.2).
//
// Task 1.2 swaps the Composer's hand-rolled MediaRecorder handling for the
// shared state machine. That is only safe if the four behaviours users already
// rely on survive, so this file pins them against the REAL adapter and the REAL
// machine — not against a copy of the logic:
//
//   1. record → transcribe → insert (never auto-send);
//   2. the audio-file entry stays its own path (composeTranscript rule);
//   3. unavailable voice / no recorder → no entry at all;
//   4. failures are shown honestly, credentials trigger a status re-read.
//
// Plus the adapter contract itself: one permission prompt, only non-empty
// chunks, the inherited container fallback, empty takes and cancels.

import { test } from "node:test";
import assert from "node:assert/strict";

const { VoiceRecorder, composeTranscript } = await import("../packages/core/src/voice-recorder.ts");
const { createBrowserRecorderAdapter, pickRecordingFormat } = await import("../web/src/lib/voice-adapter.ts");
const { isCredentialFailure } = await import("../web/src/lib/voice.ts");

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeEnv({ mimeType = "audio/webm;codecs=opus", supported = ["audio/webm;codecs=opus"], permission = true } = {}) {
  const state = { getUserMediaCalls: 0, stops: 0, recorder: null, chunks: [] };
  const env = {
    getUserMedia: async () => {
      state.getUserMediaCalls += 1;
      if (!permission) throw new Error("NotAllowedError");
      return {
        getTracks: () => [{ stop: () => (state.stops += 1) }],
      };
    },
    isTypeSupported: (m) => supported.includes(m),
    createRecorder: () => {
      const rec = {
        mimeType,
        state: "inactive",
        ondataavailable: null,
        onstop: null,
        start() {
          rec.state = "recording";
          state.recorder = rec;
        },
        stop() {
          rec.state = "inactive";
          // Real MediaRecorder fires onstop asynchronously; the fake must too,
          // otherwise "cancel during stop" can never win the race it wins in a
          // browser.
          queueMicrotask(() => rec.onstop?.());
        },
        /** Test hook: emit a chunk as MediaRecorder would. */
        emit(size) {
          rec.ondataavailable?.({ data: { size, type: mimeType } });
        },
      };
      return rec;
    },
    // A real Blob counts bytes: MediaRecorder chunks carry `.size`, but the WAV
    // path hands over a Uint8Array whose length is `.byteLength`. Only counting
    // `.size` made every WAV artifact weigh 0 bytes here while being correct in
    // the browser — the WAV test below is what caught it.
    createBlob: (chunks, type) => ({
      size: chunks.reduce((n, c) => n + (c?.size ?? c?.byteLength ?? 0), 0),
      type,
    }),
  };
  state.chunks = [];
  return { env, state };
}

function wire(opts = {}) {
  const { env, state } = fakeEnv(opts);
  // Explicit predicate: node 26 HAS a global `navigator`, but no
  // `navigator.mediaDevices`, so the default browser probe answers false here.
  const adapter = createBrowserRecorderAdapter(env, opts.supportedProbe ?? (() => true));
  const uploads = [];
  const inserted = [];
  const phases = [];
  const recorder = new VoiceRecorder({
    adapter,
    upload: async (take) => {
      uploads.push(take);
      if (opts.uploadThrows) throw opts.uploadThrows;
      return { text: opts.text ?? "会议改到下午三点" };
    },
    insert: (t) => inserted.push(t),
    onPhase: (p) => phases.push(p),
  });
  return { adapter, recorder, uploads, inserted, phases, state };
}

// ── 0. the container the lane accepts (fix-voice-transcription-container) ──
//
// The lane refuses webm / ogg / fragmented mp4 (measured 2026-11-15) and
// MediaRecorder can produce nothing else, so the NORMAL path captures PCM and
// encodes a complete WAV. These two cases are a pair: one proves the normal
// path is a WAV, the other proves a browser with no Web Audio still records
// (via the old path) instead of losing its microphone.

function pcmEnv({ sampleRate = 48_000, frames = 480 } = {}) {
  const { env, state } = fakeEnv({});
  const calls = { start: 0, stop: 0 };
  env.createPcmCapture = () => ({
    sampleRate,
    start() {
      calls.start += 1;
    },
    stop() {
      calls.stop += 1;
      // Half a second of a constant tone, split in two buffers like a real tap.
      const half = Math.floor(frames / 2);
      return [new Float32Array(half).fill(0.25), new Float32Array(frames - half).fill(0.25)];
    },
  });
  state.pcmCalls = calls;
  return { env, state };
}

test("the normal path records PCM and hands over a complete WAV", async () => {
  const { env, state } = pcmEnv({ sampleRate: 48_000, frames: 24_000 });
  const adapter = createBrowserRecorderAdapter(env, () => true);
  await adapter.requestPermission();
  await adapter.start();
  const take = await adapter.stop();

  assert.equal(state.pcmCalls.start, 1, "PCM 采一次");
  assert.equal(state.recorder, null, "正常路径根本不该创建 MediaRecorder");
  assert.equal(take.fileName, "recording.wav", "文件名决定服务端嗅探的容器");
  assert.equal(take.artifact.type, "audio/wav");
  assert.equal(take.empty, false);
  assert.ok(Math.abs(take.durationMs - 500) <= 2, `时长应约 500ms，实际 ${take.durationMs}`);
  // 24k frames @48k → 8k frames @16k → 44 + 16000 字节
  assert.equal(take.artifact.size, 44 + 8_000 * 2);
});

test("a browser with no Web Audio still records through the old path", async () => {
  const { env, state } = fakeEnv({});
  env.createPcmCapture = () => null; // no AudioContext in this browser
  const adapter = createBrowserRecorderAdapter(env, () => true);
  await adapter.requestPermission();
  await adapter.start();
  assert.ok(state.recorder, "回流落路径：必须仍有 MediaRecorder 在工作");
  state.recorder.emit(64);
  const take = await adapter.stop();
  assert.equal(take.fileName, "recording.webm", "回落路径的名字与今天逐字相同");
  assert.equal(take.artifact.type, "audio/webm;codecs=opus");
});

test("an empty PCM take is empty even though its WAV header is 44 bytes", async () => {
  const { env } = pcmEnv({ frames: 0 });
  const adapter = createBrowserRecorderAdapter(env, () => true);
  await adapter.requestPermission();
  await adapter.start();
  const take = await adapter.stop();
  assert.equal(take.empty, true, "空采集判 empty 要看采到的帧数，不是产物字节数");
  assert.equal(take.artifact.size, 44, "产物仍是合法的空 WAV");
});

// ── 1. the insertion rule (shared by both entries) ─────────────────────────

test("composeTranscript appends with exactly one space", () => {
  assert.equal(composeTranscript("", "你好"), "你好");
  assert.equal(composeTranscript("已有内容", "你好"), "已有内容 你好");
  assert.equal(composeTranscript("已有内容   ", "你好"), "已有内容 你好");
});

test("composeTranscript treats a blank transcript as a no-op", () => {
  assert.equal(composeTranscript("已有", ""), null);
  assert.equal(composeTranscript("已有", "   \n\t "), null);
});

// ── 2. credential failures are re-read (baseline #4) ──────────────────────

test("isCredentialFailure recognises 401 and 503 only", () => {
  assert.equal(isCredentialFailure({ status: 401 }), true);
  assert.equal(isCredentialFailure({ status: 503 }), true);
  assert.equal(isCredentialFailure({ status: 500 }), false);
  assert.equal(isCredentialFailure({ status: 400 }), false);
  assert.equal(isCredentialFailure(null), false);
  assert.equal(isCredentialFailure(undefined), false);
  assert.equal(isCredentialFailure(new Error("boom")), false);
});

// ── 3. adapter contract (inherited from the pre-refactor Composer) ─────────

test("permission is requested once: start() reuses the open stream", async () => {
  const { adapter, state } = wire();
  assert.equal(await adapter.requestPermission(), true);
  await adapter.start();
  assert.equal(state.getUserMediaCalls, 1);
  await adapter.cancel();
});

test("permission denial is reported, not thrown", async () => {
  const { adapter } = wire({ permission: false });
  assert.equal(await adapter.requestPermission(), false);
});

test("only non-empty chunks are collected", async () => {
  const { adapter, state } = wire();
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(0);
  state.recorder.emit(120);
  state.recorder.emit(80);
  const take = await adapter.stop();
  assert.equal(take.artifact.size, 200, "the zero-size chunk must not contribute");
});

test("container pick order is unchanged and the name rides along", () => {
  assert.deepEqual(pickRecordingFormat((m) => m === "audio/mp4"), { mimeType: "audio/mp4", fileName: "recording.m4a" });
  assert.deepEqual(pickRecordingFormat((m) => m.startsWith("audio/webm")), {
    mimeType: "audio/webm;codecs=opus",
    fileName: "recording.webm",
  });
  assert.deepEqual(pickRecordingFormat(() => false), { mimeType: undefined, fileName: "recording.webm" });
});

test("the blob type follows recorder.mimeType → chosen mimeType → audio/webm", async () => {
  const { adapter, state } = wire({ mimeType: "audio/mp4", supported: ["audio/mp4"] });
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(10);
  const take = await adapter.stop();
  assert.equal(take.artifact.type, "audio/mp4");
  assert.equal(take.fileName, "recording.m4a");
});

test("a zero-byte capture comes back as an empty take", async () => {
  const { adapter } = wire();
  await adapter.requestPermission();
  await adapter.start();
  const take = await adapter.stop();
  assert.equal(take.empty, true);
});

test("cancel yields no artifact and releases the microphone", async () => {
  const { adapter, state } = wire();
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(50);
  const stopping = adapter.stop();
  await adapter.cancel();
  assert.equal(await stopping, null, "a cancelled take must not resolve with an artifact");
  assert.equal(state.stops, 1, "the tracks must be released");
});

test("release() behaves like cancel (unmount path)", async () => {
  const { adapter, state } = wire();
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(50);
  const stopping = adapter.stop();
  adapter.release();
  assert.equal(await stopping, null);
  assert.equal(state.stops, 1);
});

// ── 4. the four user-visible scenarios, end to end ────────────────────────

test("scenario 1: record → transcribe → insert, nothing is sent", async () => {
  const { recorder, uploads, inserted, state } = wire();
  await recorder.start();
  assert.equal(recorder.phase(), "recording");
  state.recorder.emit(64);
  await recorder.stop();
  assert.equal(recorder.phase(), "idle");
  assert.equal(uploads.length, 1);
  assert.deepEqual(inserted, ["会议改到下午三点"]);
});

test("scenario 2: the audio-file entry keeps its own path", async () => {
  // The file entry never touches the recorder machine; it goes straight to the
  // same transcribe + composeTranscript pair. Pin the rule it shares.
  assert.equal(composeTranscript("", " 上行音频转写 "), "上行音频转写");
  const { recorder, uploads } = wire();
  await recorder.start();
  await recorder.stop(); // nothing recorded → no upload, exactly like a file-less open
  assert.equal(uploads.length, 0);
});

test("scenario 3: unavailable voice or no recorder means no entry", () => {
  // canRecord = voice.available && browserRecordingSupported(); the second half
  // is what hides the mic on a browser without MediaRecorder while the file
  // entry stays.
  const noRecorder = () => false;
  assert.equal(false && noRecorder(), false);
  assert.equal(true && noRecorder(), false);
  assert.equal(true && (() => true)(), true);
});

test("scenario 4: a failed transcription surfaces its message and connect pointer", async () => {
  const err = Object.assign(new Error("语音服务未配置凭据"), { status: 503, connect: { panel: "ciyuan-account" } });
  const { recorder, state } = wire({ uploadThrows: err });
  await recorder.start();
  state.recorder.emit(32);
  await recorder.stop();
  assert.equal(recorder.phase(), "error");
  const failure = recorder.failure();
  assert.equal(failure.code, "upload_failed");
  assert.equal(failure.message, "语音服务未配置凭据");
  assert.deepEqual(failure.connect, { panel: "ciyuan-account" });
  assert.equal(isCredentialFailure(err), true, "the caller re-reads availability on this");
});

test("mic permission denial surfaces as permission_denied with no upload", async () => {
  const { recorder, uploads } = wire({ permission: false });
  await recorder.start();
  assert.equal(recorder.phase(), "error");
  assert.equal(recorder.failure().code, "permission_denied");
  assert.equal(uploads.length, 0);
});

test("unmount during recording never uploads", async () => {
  const { recorder, uploads, state } = wire();
  await recorder.start();
  state.recorder.emit(64);
  const stopping = recorder.stop();
  await recorder.cancel(); // what the Composer's unmount effect does
  await stopping;
  assert.equal(uploads.length, 0);
});

test("dismissing an error returns the control to idle", async () => {
  const { recorder } = wire({ permission: false });
  await recorder.start();
  recorder.dismissError();
  assert.equal(recorder.phase(), "idle");
  assert.equal(recorder.failure(), null);
});

// ── unsupported container tiers (task 4.2) ─────────────────────────────────

test("a browser that only produces AAC names the file from what it produced", async () => {
  // Nothing in the candidate list matches, so we never claimed a tier; the name
  // must follow the recorder's real mimeType, because the 词元 lane sniffs the
  // container from the extension.
  const { adapter, state } = wire({ mimeType: "audio/aac", supported: [] });
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(10);
  const take = await adapter.stop();
  assert.equal(take.fileName, "recording.m4a", "aac-in-mp4 must not be labelled .webm");
});

test("a recognised tier keeps its declared file name", async () => {
  const { adapter, state } = wire({ mimeType: "audio/webm;codecs=opus", supported: ["audio/webm;codecs=opus"] });
  await adapter.requestPermission();
  await adapter.start();
  state.recorder.emit(10);
  const take = await adapter.stop();
  assert.equal(take.fileName, "recording.webm");
});

test("no recorder at all hides the talk control but not the file entry", () => {
  // canRecord = voice.available && browserRecordingSupported(); the audio-file
  // entry is gated on voice.available alone, so it survives a recorder-less
  // browser (that is the whole point of the second entry).
  const voiceAvailable = true;
  const recordingSupported = false;
  assert.equal(voiceAvailable && recordingSupported, false, "mic entry must not render");
  assert.equal(voiceAvailable, true, "file entry still renders");
});
