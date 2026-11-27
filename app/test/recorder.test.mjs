// App recorder adapter + upload contract (openspec: add-voice-input-mobile,
// tasks 3.2/3.3).
//
// Same contract suite as the mini-program adapter (miniapp/src/lib/recorder.ts)
// — the two clients differ only in how the platform hands back a take:
// expo-audio leaves a file at `recorder.uri`, the mini-program returns a temp
// path in `onStop`. Everything the spec pins is asserted here:
//   • prepare runs before every take;
//   • no uri ⇒ no artifact (the machine then skips the upload);
//   • a cancel during stop() voids the artifact;
//   • a 401 refreshes once and retries exactly once, then reports honestly.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createExpoRecorderAdapter, uploadExpoTake, VoiceUploadError } = await import("../src/lib/recorder.ts");

// ── fakes ───────────────────────────────────────────────────────────────────

function fakeRecorder({ uri = "file:///tmp/rec.m4a" } = {}) {
  const calls = [];
  const rec = {
    uri,
    prepared: 0,
    recorded: 0,
    stopped: 0,
    prepareToRecordAsync: async () => {
      calls.push("prepare");
      rec.prepared += 1;
    },
    record: () => {
      calls.push("record");
      rec.recorded += 1;
    },
    stop: async () => {
      calls.push("stop");
      rec.stopped += 1;
    },
  };
  return { rec, calls };
}

function adapterWith({ granted = true, uri = "file:///tmp/rec.m4a", beforeStart } = {}) {
  const { rec, calls } = fakeRecorder({ uri });
  const adapter = createExpoRecorderAdapter({
    recorder: rec,
    requestPermission: async () => granted,
    recordingOptions: { extension: ".m4a" },
    beforeStart,
  });
  return { adapter, rec, calls };
}

// ── permission ──────────────────────────────────────────────────────────────

test("a granted permission is reported as true", async () => {
  const { adapter } = adapterWith();
  assert.equal(await adapter.requestPermission(), true);
});

test("a denied permission is reported as false, not thrown", async () => {
  const { rec } = fakeRecorder();
  const adapter = createExpoRecorderAdapter({
    recorder: rec,
    requestPermission: async () => {
      throw new Error("denied");
    },
  });
  assert.equal(await adapter.requestPermission(), false);
});

test("isSupported follows the recorder instance", () => {
  const { adapter } = adapterWith();
  assert.equal(adapter.isSupported(), true);
});

// ── recording ───────────────────────────────────────────────────────────────

test("start prepares the recorder before recording", async () => {
  const { adapter, calls } = adapterWith();
  await adapter.start();
  assert.deepEqual(calls, ["prepare", "record"]);
});

test("beforeStart runs between prepare and record", async () => {
  const order = [];
  const { rec } = fakeRecorder();
  rec.prepareToRecordAsync = async () => {
    order.push("prepare");
  };
  rec.record = () => {
    order.push("record");
  };
  const adapter = createExpoRecorderAdapter({
    recorder: rec,
    requestPermission: async () => true,
    beforeStart: async () => {
      order.push("mode");
    },
  });
  await adapter.start();
  assert.deepEqual(order, ["prepare", "mode", "record"]);
});

test("a finished take carries the uri and a usable file name", async () => {
  const { adapter } = adapterWith({ uri: "file:///tmp/meeting.m4a" });
  await adapter.start();
  const take = await adapter.stop();
  assert.equal(take.artifact.uri, "file:///tmp/meeting.m4a");
  assert.equal(take.fileName, "meeting.m4a");
  assert.equal(take.empty, false);
});

test("no uri means nothing was captured", async () => {
  const { adapter, rec } = adapterWith({ uri: null });
  await adapter.start();
  const take = await adapter.stop();
  assert.equal(take, null);
  assert.equal(rec.stopped, 1);
});

test("cancel during an in-flight stop voids the artifact", async () => {
  const { adapter, rec } = adapterWith();
  await adapter.start();
  let releaseFirstStop;
  let stopCalls = 0;
  rec.stop = async () => {
    stopCalls += 1;
    // Only the FIRST stop hangs (the take being flushed); cancel's own stop
    // must return immediately, otherwise the test's resolver gets overwritten
    // and nothing can ever unblock.
    if (stopCalls === 1) {
      await new Promise((r) => {
        releaseFirstStop = r;
      });
    }
  };
  const stopping = adapter.stop();
  await adapter.cancel();
  releaseFirstStop?.();
  assert.equal(await stopping, null, "a cancelled take must not resolve with an artifact");
});

test("a second take re-prepares the recorder", async () => {
  const { adapter, rec } = adapterWith();
  await adapter.start();
  await adapter.stop();
  await adapter.start();
  assert.equal(rec.prepared, 2, "expo-audio needs prepareToRecordAsync before every take");
});

// ── upload ──────────────────────────────────────────────────────────────────

const TAKE = { artifact: { uri: "file:///tmp/rec.m4a", durationMs: 1200 }, fileName: "rec.m4a", durationMs: 1200 };

function uploadDeps(queue) {
  const calls = { posts: 0, refreshes: 0, lastBody: null };
  return {
    calls,
    deps: {
      post: async (path, body) => {
        calls.posts += 1;
        calls.lastBody = body;
        assert.equal(path, "/api/voice/transcriptions");
        const next = queue.shift();
        if (!next) throw new Error("queue exhausted");
        return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
      },
      refresh: async () => {
        calls.refreshes += 1;
      },
    },
  };
}

test("a 200 returns the transcript", async () => {
  const { deps, calls } = uploadDeps([{ status: 200, body: { text: "会议改到三点" } }]);
  assert.deepEqual(await uploadExpoTake(deps, TAKE), { text: "会议改到三点" });
  assert.equal(calls.posts, 1);
  assert.equal(calls.refreshes, 0);
});

test("the multipart field is named `file`", async () => {
  const { deps, calls } = uploadDeps([{ status: 200, body: { text: "ok" } }]);
  await uploadExpoTake(deps, TAKE);
  assert.ok(calls.lastBody instanceof FormData);
  assert.equal(calls.lastBody.get("file") !== null, true, "the server reads the field named `file`");
});

test("a 401 refreshes and retries exactly once", async () => {
  const { deps, calls } = uploadDeps([
    { status: 401, body: { error: "expired" } },
    { status: 200, body: { text: "重登后成功" } },
  ]);
  assert.deepEqual(await uploadExpoTake(deps, TAKE), { text: "重登后成功" });
  assert.equal(calls.posts, 2);
  assert.equal(calls.refreshes, 1);
});

test("a second 401 is surfaced, never retried again", async () => {
  const { deps, calls } = uploadDeps([
    { status: 401, body: {} },
    { status: 401, body: { error: "still expired" } },
  ]);
  await assert.rejects(
    () => uploadExpoTake(deps, TAKE),
    (err) => {
      assert.ok(err instanceof VoiceUploadError);
      assert.equal(err.status, 401);
      assert.equal(err.message, "still expired");
      return true;
    },
  );
  assert.equal(calls.posts, 2);
});

test("a 503 carries message, code and connect pointer", async () => {
  const { deps } = uploadDeps([
    {
      status: 503,
      body: { error: "语音服务未配置凭据", code: "voice_not_configured", connect: { panel: "ciyuan-account" } },
    },
  ]);
  await assert.rejects(
    () => uploadExpoTake(deps, TAKE),
    (err) => {
      assert.equal(err.message, "语音服务未配置凭据");
      assert.equal(err.code, "voice_not_configured");
      assert.deepEqual(err.connect, { panel: "ciyuan-account" });
      return true;
    },
  );
});

test("a non-JSON body still yields a readable failure", async () => {
  const { deps } = uploadDeps([{ status: 502, body: "<html>bad gateway</html>" }]);
  await assert.rejects(
    () => uploadExpoTake(deps, TAKE),
    (err) => {
      assert.match(err.message, /502/);
      return true;
    },
  );
});
