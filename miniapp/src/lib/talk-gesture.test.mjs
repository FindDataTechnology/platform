// Hold-to-talk gesture rule (openspec: add-voice-input-mobile, task 2.3).
//
// The four gestures the spec names, asserted on the pure rule instead of on a
// device. "取消后零请求" is pinned by the last test: after a cancel the gesture
// never calls onStop, so the machine never reaches upload.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createTalkGesture } = await import("./talk-gesture.ts");

function harness(opts = {}) {
  const calls = [];
  const gesture = createTalkGesture(
    {
      onStart: () => calls.push("start"),
      onStop: () => calls.push("stop"),
      onCancel: () => calls.push("cancel"),
    },
    opts,
  );
  return { gesture, calls };
}

test("press and release records then transcribes", () => {
  const { gesture, calls } = harness();
  gesture.begin(400);
  gesture.end();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("sliding up past the threshold cancels and never stops", () => {
  const { gesture, calls } = harness({ slideUpPx: 60 });
  gesture.begin(400);
  gesture.move(400 - 60);
  gesture.end();
  assert.deepEqual(calls, ["start", "cancel"], "a cancelled take must not reach stop()");
  assert.equal(calls.includes("stop"), false, "no stop ⇒ no artifact ⇒ no upload request");
});

test("a small move stays a normal take", () => {
  const { gesture, calls } = harness({ slideUpPx: 60 });
  gesture.begin(400);
  gesture.move(400 - 59);
  gesture.end();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("cancel is one-way: sliding back down does not resurrect the take", () => {
  const { gesture, calls } = harness({ slideUpPx: 60 });
  gesture.begin(400);
  gesture.move(300); // into the cancel zone
  gesture.move(420); // back down, below the start point
  gesture.end();
  assert.deepEqual(calls, ["start", "cancel"]);
});

test("a second begin while active is ignored", () => {
  const { gesture, calls } = harness();
  gesture.begin(400);
  gesture.begin(410);
  gesture.end();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("end without begin is a no-op", () => {
  const { gesture, calls } = harness();
  gesture.end();
  gesture.move(100);
  assert.deepEqual(calls, []);
});

test("programmatic cancel fires once and ends the take", () => {
  const { gesture, calls } = harness();
  gesture.begin(400);
  gesture.cancel();
  gesture.cancel();
  gesture.end();
  assert.deepEqual(calls, ["start", "cancel"]);
});

test("programmatic cancel after a slide-cancel does not double-fire", () => {
  const { gesture, calls } = harness({ slideUpPx: 60 });
  gesture.begin(400);
  gesture.move(300);
  gesture.cancel();
  assert.deepEqual(calls, ["start", "cancel"]);
});

test("state flags track the gesture", () => {
  const { gesture } = harness({ slideUpPx: 60 });
  assert.equal(gesture.isActive(), false);
  gesture.begin(400);
  assert.equal(gesture.isActive(), true);
  gesture.move(320);
  assert.equal(gesture.isCancelling(), true);
  gesture.end();
  assert.equal(gesture.isActive(), false);
  assert.equal(gesture.isCancelling(), false);
});
