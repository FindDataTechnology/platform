// Mini-program recorder adapter + upload contract (openspec:
// add-voice-input-mobile, tasks 2.1 and 2.2).
//
// recorder.ts is deliberately Taro-free, so the platform contract can be
// exercised here in node with a fake recorder manager. What is pinned:
//   • a denied `scope.record` answers false WITHOUT asking again;
//   • cancel while a take is landing yields no artifact (late onStop ignored);
//   • an empty capture comes back as `empty: true`;
//   • a 401 re-logins silently and retries EXACTLY once, then reports honestly;
//   • a second 401 is surfaced with its message/code/connect, never retried.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createMiniRecorderAdapter, uploadTakeToVoice, VoiceUploadError } = await import("./recorder.ts");

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeManager() {
  const handlers = { start: [], stop: [], error: [] };
  const state = { started: 0, stopped: 0, lastOpts: null };
  const mgr = {
    start(opts) {
      state.started += 1;
      state.lastOpts = opts;
      // wx fires onStart asynchronously.
      queueMicrotask(() => {
        for (const cb of handlers.start) cb();
      });
    },
    stop() {
      state.stopped += 1;
    },
    onStart(cb) {
      handlers.start = [cb];
    },
    onStop(cb) {
      handlers.stop = [cb];
    },
    onError(cb) {
      handlers.error = [cb];
    },
    /** Test hook: emulate the platform delivering a finished take. */
    emitStop({ tempFilePath = "wxfile://tmp/rec.mp3", fileSize = 1024, duration = 2500 } = {}) {
      queueMicrotask(() => {
        for (const cb of handlers.stop) cb({ tempFilePath, fileSize, duration });
      });
    },
    emitError(errMsg = "operateRecorder:fail") {
      queueMicrotask(() => {
        for (const cb of handlers.error) cb({ errMsg });
      });
    },
  };
  return { mgr, state, handlers };
}

function adapterWith({ authState = undefined, requestAuthResult = true, supported = true } = {}) {
  const { mgr, state } = fakeManager();
  const authCalls = { asked: 0 };
  const adapter = createMiniRecorderAdapter({
    isSupported: () => supported,
    getRecorderManager: () => mgr,
    getAuthSetting: async () => authState,
    requestAuth: async () => {
      authCalls.asked += 1;
      return requestAuthResult;
    },
  });
  return { adapter, mgr, state, authCalls };
}

// ── permission ──────────────────────────────────────────────────────────────

test("granted permission needs no prompt", async () => {
  const { adapter, authCalls } = adapterWith({ authState: true });
  assert.equal(await adapter.requestPermission(), true);
  assert.equal(authCalls.asked, 0);
});

test("a denied permission is answered false and never re-prompted", async () => {
  const { adapter, authCalls } = adapterWith({ authState: false });
  assert.equal(await adapter.requestPermission(), false);
  // A second tap must not reach the platform again (spec: 被拒后不再弹系统框).
  assert.equal(await adapter.requestPermission(), false);
  assert.equal(authCalls.asked, 0, "the OS prompt must not be re-triggered after a denial");
});

test("never-asked permission prompts exactly once", async () => {
  const { adapter, authCalls } = adapterWith({ authState: undefined, requestAuthResult: true });
  assert.equal(await adapter.requestPermission(), true);
  assert.equal(authCalls.asked, 1);
});

test("requestAuth rejection is reported as denied, not thrown", async () => {
  const { mgr } = fakeManager();
  const adapter = createMiniRecorderAdapter({
    isSupported: () => true,
    getRecorderManager: () => mgr,
    getAuthSetting: async () => undefined,
    requestAuth: async () => {
      throw new Error("authorize:fail auth deny");
    },
  });
  assert.equal(await adapter.requestPermission(), false);
});

test("an unsupported platform reports isSupported false", () => {
  const { adapter } = adapterWith({ supported: false });
  assert.equal(adapter.isSupported(), false);
});

// ── recording ───────────────────────────────────────────────────────────────

test("start uses mp3 and the configured ceiling", async () => {
  const { adapter, state } = adapterWith({ authState: true });
  await adapter.requestPermission();
  await adapter.start();
  assert.equal(state.started, 1);
  assert.equal(state.lastOpts.format, "mp3");
  assert.equal(state.lastOpts.duration, 600_000);
  assert.equal(state.lastOpts.numberOfChannels, 1);
  await adapter.cancel();
});

test("a finished take carries the file path, size and duration", async () => {
  const { adapter, mgr } = adapterWith({ authState: true });
  await adapter.requestPermission();
  await adapter.start();
  const stopping = adapter.stop();
  mgr.emitStop({ tempFilePath: "wxfile://tmp/meeting.mp3", fileSize: 2048, duration: 4200 });
  const take = await stopping;
  assert.equal(take.artifact.filePath, "wxfile://tmp/meeting.mp3");
  assert.equal(take.artifact.fileSize, 2048);
  assert.equal(take.artifact.durationMs, 4200);
  assert.equal(take.fileName, "meeting.mp3");
  assert.equal(take.empty, false);
});

test("an empty capture is flagged so the machine skips the upload", async () => {
  const { adapter, mgr } = adapterWith({ authState: true });
  await adapter.requestPermission();
  await adapter.start();
  const stopping = adapter.stop();
  mgr.emitStop({ fileSize: 0 });
  const take = await stopping;
  assert.equal(take.empty, true);
});

test("cancel while the take is landing yields no artifact", async () => {
  const { adapter, mgr } = adapterWith({ authState: true });
  await adapter.requestPermission();
  await adapter.start();
  const stopping = adapter.stop();
  await adapter.cancel();
  mgr.emitStop(); // the platform still delivers a late onStop
  assert.equal(await stopping, null, "a cancelled take must not resolve with an artifact");
});

test("a stop error resolves null instead of hanging", async () => {
  const { adapter, mgr } = adapterWith({ authState: true });
  await adapter.requestPermission();
  await adapter.start();
  const stopping = adapter.stop();
  mgr.emitError("operateRecorder:fail stop");
  assert.equal(await stopping, null);
});

test("start failure rejects (the machine turns it into recorder_failed)", async () => {
  const { mgr } = fakeManager();
  const adapter = createMiniRecorderAdapter({
    isSupported: () => true,
    getRecorderManager: () => mgr,
    getAuthSetting: async () => true,
    requestAuth: async () => true,
  });
  mgr.start = () => {
    throw new Error("operateRecorder:fail start");
  };
  await assert.rejects(() => adapter.start(), /operateRecorder/);
});

// ── upload (task 2.2) ───────────────────────────────────────────────────────

const TAKE = {
  artifact: { filePath: "wxfile://tmp/rec.mp3", fileSize: 900, durationMs: 1500 },
  fileName: "rec.mp3",
  durationMs: 1500,
};

function uploadDeps(queue) {
  const calls = { uploads: 0, refreshes: 0 };
  return {
    calls,
    deps: {
      apiBase: "https://example.test",
      authHeaders: () => ({ Authorization: "Bearer t" }),
      refreshToken: async () => {
        calls.refreshes += 1;
        return true;
      },
      uploadFile: async (opts) => {
        calls.uploads += 1;
        assert.equal(opts.name, "file", "the server reads the multipart field named `file`");
        assert.equal(opts.url, "https://example.test/api/voice/transcriptions");
        const next = queue.shift();
        if (!next) throw new Error("queue exhausted");
        return next;
      },
    },
  };
}

test("a 200 returns the transcript", async () => {
  const { deps, calls } = uploadDeps([{ statusCode: 200, data: JSON.stringify({ text: "会议改到三点" }) }]);
  assert.deepEqual(await uploadTakeToVoice(deps, TAKE), { text: "会议改到三点" });
  assert.equal(calls.uploads, 1);
  assert.equal(calls.refreshes, 0);
});

test("a 401 re-logins once and retries exactly once", async () => {
  const { deps, calls } = uploadDeps([
    { statusCode: 401, data: JSON.stringify({ error: "token expired" }) },
    { statusCode: 200, data: JSON.stringify({ text: "重登后成功" }) },
  ]);
  assert.deepEqual(await uploadTakeToVoice(deps, TAKE), { text: "重登后成功" });
  assert.equal(calls.uploads, 2);
  assert.equal(calls.refreshes, 1);
});

test("a second 401 is surfaced, never retried again", async () => {
  const { deps, calls } = uploadDeps([
    { statusCode: 401, data: JSON.stringify({ error: "nope" }) },
    { statusCode: 401, data: JSON.stringify({ error: "still nope" }) },
  ]);
  await assert.rejects(
    () => uploadTakeToVoice(deps, TAKE),
    (err) => {
      assert.ok(err instanceof VoiceUploadError);
      assert.equal(err.status, 401);
      return true;
    },
  );
  assert.equal(calls.uploads, 2, "exactly one retry — a dead binding must not become a request storm");
  assert.equal(calls.refreshes, 1);
});

test("a failed re-login does not retry", async () => {
  const { deps, calls } = uploadDeps([{ statusCode: 401, data: "{}" }]);
  deps.refreshToken = async () => {
    calls.refreshes += 1;
    return false;
  };
  await assert.rejects(() => uploadTakeToVoice(deps, TAKE));
  assert.equal(calls.uploads, 1, "no retry when the silent re-login itself failed");
});

test("a 503 carries the server message, code and connect pointer", async () => {
  const { deps } = uploadDeps([
    {
      statusCode: 503,
      data: JSON.stringify({ error: "语音服务未配置凭据", code: "voice_not_configured", connect: { panel: "ciyuan-account" } }),
    },
  ]);
  await assert.rejects(
    () => uploadTakeToVoice(deps, TAKE),
    (err) => {
      assert.equal(err.message, "语音服务未配置凭据");
      assert.equal(err.code, "voice_not_configured");
      assert.deepEqual(err.connect, { panel: "ciyuan-account" });
      return true;
    },
  );
});

test("a non-JSON body still yields a readable failure", async () => {
  const { deps } = uploadDeps([{ statusCode: 502, data: "<html>bad gateway</html>" }]);
  await assert.rejects(
    () => uploadTakeToVoice(deps, TAKE),
    (err) => {
      assert.match(err.message, /502/);
      return true;
    },
  );
});

test("a trailing slash in the base URL does not double up", async () => {
  const { deps, calls } = uploadDeps([{ statusCode: 200, data: JSON.stringify({ text: "ok" }) }]);
  deps.apiBase = "https://example.test///";
  await uploadTakeToVoice(deps, TAKE);
  assert.equal(calls.uploads, 1);
});
