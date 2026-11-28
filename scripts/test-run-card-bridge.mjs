#!/usr/bin/env node
// ── Run Card bridge (run-card-bridge) ───────────────────────────────────────
//
// Pins the round trip and the two new criterion kinds. Run with:
//   node --test scripts/test-run-card-bridge.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { toRunCard, fromRunCard } from "../server/run-card-bridge.js";
import { CARD_ASSERTION_KINDS, evaluateAcceptance, validateFlowDeclaration } from "../server/task-flow.js";

const tempRoot = mkdtempSync(path.join(tmpdir(), "run-card-bridge-"));
test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

const task = () => ({
  id: "t1",
  prompt: "write out.md",
  state: "done",
  history: [
    { state: "done", success: true, text: "wrote it" },
    { state: "done", success: true, text: "wrote it again" },
  ],
  flow: {
    flowId: "f1",
    stationId: "s1",
    sortKey: "a",
    acceptance: [{ id: "a1", kind: "artifact-exists", target: "out.md" }],
    stakedAt: "2026-01-01T00:00:00.000Z",
    verdict: { outcome: "pass", by: "criteria", at: "2026-01-01T00:00:05.000Z" },
    sessionId: "must-not-export",
  },
});

test("round trip preserves id, flow, history and verdict", () => {
  const before = task();
  const card = toRunCard(before, { deadlineSeconds: 60 });
  const after = fromRunCard(card);
  assert.equal(after.id, before.id);
  assert.equal(after.prompt, before.prompt);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.flow.flowId, before.flow.flowId);
  assert.equal(after.flow.stationId, before.flow.stationId);
  assert.deepEqual(after.flow.verdict, before.flow.verdict);
  assert.deepEqual(after.flow.acceptance, before.flow.acceptance);
});

test("envelope never carries a session id", () => {
  const card = toRunCard(task(), { deadlineSeconds: 60 });
  assert.ok(!JSON.stringify(card).includes("must-not-export"));
});

test("export refuses to fabricate a deadline", () => {
  assert.throws(() => toRunCard(task()), /deadlineSeconds/);
});

test("import rejects a kind outside the task-flow vocabulary", () => {
  const card = toRunCard(task(), { deadlineSeconds: 60 });
  card.acceptance = [{ id: "x", kind: "vibes-are-good" }];
  assert.throws(() => fromRunCard(card), /outside the task-flow vocabulary/);
});

test("command-succeeds without a target is accepted", () => {
  const r = validateFlowDeclaration({
    flowId: "no-target",
    name: "no target",
    stations: [{ stationId: "s", target: { kind: "persona", ref: "p" }, acceptance: [{ id: "a", kind: "command-succeeds" }] }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("file-contains and exit-code are in the card vocabulary", () => {
  assert.ok(CARD_ASSERTION_KINDS.includes("file-contains"));
  assert.ok(CARD_ASSERTION_KINDS.includes("exit-code"));
});

test("file-contains: pass, fail, and unknown when unreadable", () => {
  writeFileSync(path.join(tempRoot, "report.md"), "three actionable suggestions\n");
  const facts = { workspace: tempRoot };
  const run = (expect) => evaluateAcceptance(
    [{ id: "f", kind: "file-contains", target: "report.md", expect }],
    { facts },
  );
  assert.equal(run("actionable").outcome, "pass");
  assert.equal(run("absent").outcome, "fail");
  const missing = evaluateAcceptance(
    [{ id: "f", kind: "file-contains", target: "nope.md", expect: "x" }],
    { facts },
  );
  assert.equal(missing.outcome, "unknown");
});

test("exit-code: pass, fail, and unknown when not captured", () => {
  const run = (exitCode) => evaluateAcceptance(
    [{ id: "e", kind: "exit-code", expect: 0 }],
    { facts: exitCode === undefined ? {} : { exitCode } },
  );
  assert.equal(run(0).outcome, "pass");
  assert.equal(run(1).outcome, "fail");
  assert.equal(run(undefined).outcome, "unknown");
});

test("an unknown kind is unknown, never a pass", () => {
  const r = evaluateAcceptance([{ id: "x", kind: "vibes-are-good" }], {});
  assert.equal(r.outcome, "unknown");
  assert.notEqual(r.outcome, "pass");
});

test("a judge without a judge is unknown, never a pass", () => {
  const r = evaluateAcceptance([{ id: "j", kind: "llm-judged", rubric: "x" }], {});
  assert.equal(r.outcome, "unknown");
  assert.equal(r.judged[0].outcome, "unknown");
});
