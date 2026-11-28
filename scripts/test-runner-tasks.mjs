// Unit tests for the runner's task registry (harden-agent-runtime-spine,
// a2a-task-handle 4.x). Storage-only: no express, no manager.
//
// Covers:
//   - an id minted at accept is addressable before the turn finishes
//   - settle is one-way (a late settle cannot rewrite the winner)
//   - `unknown` is its own state (not "failed", not "not found")
//   - cancel is not silently convertible into error, and vice versa
//   - the registry is bounded (oldest evicted first) — a long-lived runner
//     must not grow without limit
//
// Run: node --test scripts/test-runner-tasks.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { createTaskRegistry, TASK_STATES } = await import("../agent-runner/tasks.js");

test("terminal vocabulary is the closed set the claim lane uses", () => {
  assert.deepEqual([...TASK_STATES], ["running", "done", "error", "cancelled"]);
});

test("accept: addressable before the turn finishes, state running", () => {
  const r = createTaskRegistry({ now: () => 1000 });
  r.open({ taskId: "t1", agentKey: "a", sessionId: "s", text: "hi" });
  const d = r.describe("t1");
  assert.equal(d.state, "running");
  assert.equal(d.session_id, "s");
  assert.equal(d.opened_at, 1000);
});

test("replay: a second open for the same id keeps the FIRST start time", () => {
  let t = 1000;
  const r = createTaskRegistry({ now: () => t });
  r.open({ taskId: "t1", agentKey: "a", sessionId: "s" });
  t = 5000;
  r.open({ taskId: "t1", agentKey: "a", sessionId: "s" });
  assert.equal(r.describe("t1").opened_at, 1000, "the start is a fact, not something a retry moves");
  assert.equal(r.size(), 1);
});

test("settle: one-way — the first settle wins, a late one reads the winner", () => {
  const r = createTaskRegistry({ now: () => 1000 });
  r.open({ taskId: "t1", agentKey: "a", sessionId: "s" });
  r.settle("t1", { state: "cancelled", cancelledBy: "caller" });
  r.settle("t1", { state: "error", error: { message: "late" } });
  const d = r.describe("t1");
  assert.equal(d.state, "cancelled");
  assert.equal(d.error, undefined, "the late error never landed");
});

test("settle: a value outside the set is refused, and running is not a terminal", () => {
  const r = createTaskRegistry();
  r.open({ taskId: "t1" });
  r.settle("t1", { state: "timeout" });
  assert.equal(r.describe("t1").state, "running", "an invented word cannot close a task");
  r.settle("t1", { state: "running" });
  assert.equal(r.describe("t1").state, "running");
});

test("unknown: a task this process never saw is `unknown`, with a reason", () => {
  const r = createTaskRegistry();
  const d = r.describe("nope");
  assert.equal(d.state, "unknown");
  assert.match(d.reason, /no|not|window/i);
});

test("done carries the result; error carries the error; cancelled carries who", () => {
  const r = createTaskRegistry();
  r.open({ taskId: "a" });
  r.settle("a", { state: "done", result: { text: "ok" } });
  assert.deepEqual(r.describe("a").result, { text: "ok" });

  r.open({ taskId: "b" });
  r.settle("b", { state: "error", error: { code: -32003, message: "boom" } });
  assert.equal(r.describe("b").error.code, -32003);

  r.open({ taskId: "c" });
  r.settle("c", { state: "cancelled", cancelledBy: "caller:x" });
  assert.equal(r.describe("c").cancelled_by, "caller:x");
});

test("bounded: the oldest entry is evicted, the newest survives", () => {
  const r = createTaskRegistry({ max: 3 });
  for (const id of ["a", "b", "c", "d", "e"]) r.open({ taskId: id });
  assert.equal(r.size(), 3);
  assert.equal(r.describe("a").state, "unknown", "oldest evicted");
  assert.equal(r.describe("e").state, "running", "newest retained");
});

test("cancel: a settled task cannot be flipped to cancelled", () => {
  const r = createTaskRegistry();
  r.open({ taskId: "t" });
  r.settle("t", { state: "done", result: { text: "finished" } });
  r.cancel("t", { by: "caller" });
  assert.equal(r.describe("t").state, "done", "you cannot cancel what already finished");
  assert.equal(r.describe("t").result.text, "finished");
});
