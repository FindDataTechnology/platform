#!/usr/bin/env node
// ── Acceptance: staking, evidence, evaluation (add-task-flow, tasks 3.1–3.3)
//
// The claim this file protects is the reason the change exists: `done` is not
// "the executor says so". A check that can be satisfied by prose is not a
// check, and a station with no declared check must never read as verified.
//
//   node --test scripts/test-task-flow-acceptance.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-accept-"));
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.CRON_STORAGE_PATH = tmpRoot;

const flow = await import("../server/task-flow.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── 3.1 staking ──────────────────────────────────────────────────────────────

test("staking: acceptance is stamped onto the card, not read later from the flow", () => {
  const station = {
    stationId: "gate",
    acceptance: [{ id: "has", kind: "artifact-exists", target: "out.md" }],
  };
  const stamped = flow.stampAcceptance({ flowId: "f" }, station);
  assert.equal(stamped.stationId, "gate");
  assert.deepEqual(stamped.acceptance, station.acceptance);
  assert.ok(stamped.stakedAt, "the stamp carries when it was fixed");

  // The asymmetry that matters: mutating the flow's station afterwards must not
  // reach the stamped card. This is what makes the predicate "decided before
  // dispatch" rather than "whatever the flow says when the executor finishes".
  station.acceptance.push({ id: "sneaky", kind: "artifact-exists", target: "other.md" });
  assert.equal(stamped.acceptance.length, 1, "the staked copy is independent of the declaration");
});

test("staking: re-dispatch to a new station re-stakes with the new station's criteria", () => {
  const first = flow.stampAcceptance({ flowId: "f" }, { stationId: "a", acceptance: [{ id: "1", kind: "command-succeeds", target: "x" }] });
  const second = flow.stampAcceptance(first, { stationId: "b", acceptance: [] });
  assert.equal(second.stationId, "b");
  assert.deepEqual(second.acceptance, [], "the old station's criteria do not follow the card");
  assert.equal(second.flowId, "f", "flow attribution is preserved by the re-stake");
});

// ── 3.2 evaluation ───────────────────────────────────────────────────────────

test("eval: no declared criteria is its own outcome, never a pass", () => {
  const r = flow.evaluateAcceptance([], {});
  assert.equal(r.outcome, "no-criteria");
  // The failure mode this guards: a station with an empty acceptance list
  // silently auto-accepting every card that lands on it.
  assert.notEqual(r.outcome, "pass");
});

test("eval: machine and judge results are reported in separate lists", () => {
  const acceptance = [
    { id: "m1", kind: "artifact-exists", target: "out.md" },
    { id: "j1", kind: "llm-judged", rubric: "读起来像人写的" },
  ];
  const evidence = { artifacts: [{ path: "out.md", bytes: 42 }] };
  const r = flow.evaluateAcceptance(acceptance, evidence, { judge: () => true });
  assert.equal(r.outcome, "pass");
  assert.equal(r.machine.length, 1);
  assert.equal(r.judged.length, 1);
  // A reader must be able to tell which tier vouched for this.
  assert.equal(r.machine[0].kind, "artifact-exists");
  assert.equal(r.judged[0].kind, "llm-judged");
});

test("eval: executor prose cannot satisfy a machine assertion", () => {
  // The card's history says "done, file written" but there is no artifact.
  const acceptance = [{ id: "m1", kind: "artifact-exists", target: "out.md" }];
  const r = flow.evaluateAcceptance(acceptance, {
    artifacts: [],
    output: "I have written out.md successfully!",
  });
  assert.equal(r.outcome, "fail");
  assert.equal(r.failed[0].id, "m1");
});

test("eval: an empty artifact is not evidence", () => {
  const r = flow.evaluateAcceptance(
    [{ id: "m1", kind: "artifact-exists", target: "out.md" }],
    { artifacts: [{ path: "out.md", bytes: 0 }] },
  );
  assert.equal(r.outcome, "fail");
});

test("eval: a judge assertion without a judge is unknown, never a pass", () => {
  const r = flow.evaluateAcceptance([{ id: "j1", kind: "llm-judged", rubric: "x" }], {});
  assert.equal(r.outcome, "unknown");
  // "Unevaluated" must be distinguishable from "evaluated and failed" and from
  // a pass. An unrun check is not agreement.
  assert.equal(r.judged[0].outcome, "unknown");
});

test("eval: an unknown machine assertion kind is unknown, never a pass", () => {
  const r = flow.evaluateAcceptance([{ id: "x", kind: "vibes-are-good" }], {});
  assert.equal(r.outcome, "unknown");
});

test("eval: one failing assertion fails the station even when others pass", () => {
  const acceptance = [
    { id: "ok", kind: "command-succeeds", target: "true" },
    { id: "no", kind: "output-contains", expect: "MISSING" },
  ];
  const r = flow.evaluateAcceptance(acceptance, { success: true, output: "all good" });
  assert.equal(r.outcome, "fail");
  assert.deepEqual(r.failed.map((f) => f.id), ["no"]);
});

// ── 3.3 cost cap ─────────────────────────────────────────────────────────────

test("cap: more judge assertions than the cap is refused at declaration time", () => {
  const cap = Number(process.env.BLUEPRINT_JUDGE_MAX || 8);
  const tooMany = Array.from({ length: cap + 1 }, (_, i) => ({ id: `j${i}`, kind: "llm-judged", rubric: `r${i}` }));
  const r = flow.validateFlowDeclaration({
    flowId: "cap-test",
    name: "cap",
    stations: [{ stationId: "s", target: { kind: "persona", ref: "p" }, acceptance: tooMany }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error.includes("over the cap")), JSON.stringify(r.errors));
});

// ── evidence collection ──────────────────────────────────────────────────────

test("evidence: reads the ENGINE's own history shape, not an invented one", () => {
  // Measured on a real turn (2026-11-19): {state, success, text, duration}.
  // An earlier version of this function read `exitCode`/`output` — fields the
  // engine never writes — which made `command-succeeds` unpassable forever.
  const ev = flow.evidenceFromExecution({
    history: [{ state: "done", success: true, text: "Documents (4): ..." }],
    artifacts: [{ path: "out.md", bytes: 10 }],
  });
  assert.equal(ev.success, true);
  assert.equal(ev.state, "done");
  assert.equal(ev.output, "Documents (4): ...");
  assert.equal(ev.artifacts.length, 1);
});

test("evidence: a failed turn is not evidence of success", () => {
  const ev = flow.evidenceFromExecution({ history: [{ state: "failed", success: false, error: "boom" }] });
  assert.equal(ev.success, false);
  // And the predicate agrees.
  const r = flow.evaluateAcceptance([{ id: "ok", kind: "command-succeeds", target: "x" }], ev);
  assert.equal(r.outcome, "fail");
});

test("predicate: command-succeeds passes on a successful turn (the real shape)", () => {
  // The card this was found on: a tool round that ran and succeeded. Before the
  // fix this永远 failed because there is no exit code to read.
  const r = flow.evaluateAcceptance(
    [{ id: "ran", kind: "command-succeeds", target: "list_library" }],
    { success: true, state: "done", output: "Documents (4)" },
  );
  assert.equal(r.outcome, "pass", JSON.stringify(r));
});
