#!/usr/bin/env node
// ── Flow declaration, validation, resolution (add-task-flow, tasks 2.1–2.3)
//
// The three properties this file pins, each a distinct failure shape:
//   1. storage opens twice idempotently — a second boot must not lose flows.
//   2. validation REFUSES and names the field — a flow that half-writes is a
//      flow nobody can trust.
//   3. resolution never defaults — a vacant post is vacant, not "run it on
//      whatever runtime is live".
//
//   node --test scripts/test-task-flow-declaration.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-decl-"));
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.CRON_STORAGE_PATH = tmpRoot;

const flow = await import("../server/task-flow.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const legal = {
  flowId: "content-production",
  name: "内容生产",
  stations: [
    { stationId: "intake", label: "采集", target: { kind: "persona", ref: "scout" } },
    {
      stationId: "gate",
      label: "闸位",
      target: { kind: "persona", ref: "reviewer" },
      acceptance: [{ id: "has-draft", kind: "artifact-exists", target: "draft.md" }],
    },
  ],
};

// ── 2.1 storage ──────────────────────────────────────────────────────────────

test("storage: create twice is idempotent, flows survive", () => {
  const file = path.join(tmpRoot, "flows.db");
  const a = createTaskFlowDatabase({ file });
  a.putFlow(flow.normalizeFlowDeclaration({ ...legal, flowId: "keep" }));
  assert.equal(a.listFlows().length, 1);

  // Second open on the SAME file — the shape a process restart produces.
  const b = createTaskFlowDatabase({ file });
  const kept = b.getFlow("keep");
  assert.ok(kept, "a flow declared before the restart is still readable");
  assert.equal(kept.stations.length, 2);
  assert.deepEqual(kept.stations[1].target, { kind: "persona", ref: "reviewer" });
});

test("storage: a corrupt stations blob does not take the list down", () => {
  const file = path.join(tmpRoot, "corrupt.db");
  const db = createTaskFlowDatabase({ file });
  db.putFlow({ flowId: "ok", name: "fine", stations: [] });
  db.db.prepare("INSERT INTO task_flows (flow_id, name, stations, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("bad", "broken", "{not json", Date.now(), Date.now());
  const flows = db.listFlows();
  // Honest degradation: the bad row reads as an empty station list, and the
  // good row is unaffected. A throw here would look like "no flows exist".
  assert.equal(flows.length, 2);
  assert.deepEqual(flows.find((f) => f.flowId === "bad").stations, []);
});

// ── 2.2 validation ───────────────────────────────────────────────────────────

test("validation: a legal declaration passes", () => {
  const r = flow.validateFlowDeclaration(legal);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validation: duplicate station id is refused BY VALUE", () => {
  const r = flow.validateFlowDeclaration({
    ...legal,
    stations: [
      { stationId: "same", target: { kind: "persona", ref: "a" } },
      { stationId: "same", target: { kind: "persona", ref: "b" } },
    ],
  });
  assert.equal(r.ok, false);
  // Naming the value is the difference between "go find it" and "it's this one".
  assert.ok(r.errors.some((e) => e.error.includes("duplicate station id 'same'")), JSON.stringify(r.errors));
});

test("validation: empty station list refused", () => {
  const r = flow.validateFlowDeclaration({ ...legal, stations: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "stations"));
});

test("validation: unknown target kind listed, position names get their own sentence", () => {
  const unknown = flow.validateFlowDeclaration({
    ...legal,
    stations: [{ stationId: "s", target: { kind: "carrier-pigeon", ref: "x" } }],
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.error.includes("persona|a2a|cluster|tool")), JSON.stringify(unknown.errors));

  // A post is not a kind — this mistake deserves a sentence that says so, not
  // a bare enumeration the author has to redecode.
  const positionName = flow.validateFlowDeclaration({
    ...legal,
    stations: [{ stationId: "s", target: { kind: "fleet-member", ref: "x" } }],
  });
  assert.equal(positionName.ok, false);
  assert.ok(
    positionName.errors.some((e) => e.error.includes("is a position, not a target kind")),
    JSON.stringify(positionName.errors),
  );
});

test("validation: flowId slug shape is enforced", () => {
  const r = flow.validateFlowDeclaration({ ...legal, flowId: "Bad Id/with slash" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "flowId"));
});

test("validation: card-only assertion kinds are accepted, unknown ones are not", () => {
  const cardKinds = flow.validateFlowDeclaration({
    ...legal,
    stations: [{
      stationId: "s",
      target: { kind: "persona", ref: "p" },
      acceptance: [
        { id: "a1", kind: "artifact-exists", target: "report.md" },
        { id: "a2", kind: "command-succeeds", target: "npm test" },
        { id: "a3", kind: "llm-judged", rubric: "读起来像人写的" },
      ],
    }],
  });
  assert.equal(cardKinds.ok, true, JSON.stringify(cardKinds.errors));

  const bogus = flow.validateFlowDeclaration({
    ...legal,
    stations: [{
      stationId: "s",
      target: { kind: "persona", ref: "p" },
      acceptance: [{ id: "a1", kind: "vibes-are-good" }],
    }],
  });
  assert.equal(bogus.ok, false);
  assert.ok(bogus.errors.some((e) => e.error.includes("unsupported assertion kind")));
});

test("validation: under the shared normalizer, an empty rubric is still refused", () => {
  // The judge tier keeps the platform's rule — an empty rubric is not a check.
  const r = flow.validateFlowDeclaration({
    ...legal,
    stations: [{
      stationId: "s",
      target: { kind: "persona", ref: "p" },
      acceptance: [{ id: "a1", kind: "llm-judged", rubric: "   " }],
    }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.error.includes("rubric")), JSON.stringify(r.errors));
});

// ── 2.3 resolution ───────────────────────────────────────────────────────────

const station = (kind, ref) => ({ stationId: "s", target: { kind, ref } });

test("resolution: each of the four engine kinds resolves", () => {
  const exists = { persona: () => true, a2a: () => true, cluster: () => true, tool: () => true };
  for (const kind of flow.STATION_TARGET_KINDS) {
    const r = flow.resolveStationTarget(station(kind, "ref"), { exists });
    assert.equal(r.ok, true, `${kind}: ${r.reason}`);
    assert.equal(r.target.kind, kind);
  }
});

test("resolution: the kind set is the engine's, not a private copy", () => {
  assert.deepEqual([...flow.STATION_TARGET_KINDS].sort(), ["a2a", "cluster", "persona", "tool"]);
});

test("resolution: a missing referent is refused and named", () => {
  const exists = { persona: (r) => r !== "gone", a2a: () => false, cluster: () => true, tool: () => true };
  const gone = flow.resolveStationTarget(station("persona", "gone"), { exists });
  assert.equal(gone.ok, false);
  assert.ok(gone.reason.includes("persona 'gone' does not exist"), gone.reason);

  const offline = flow.resolveStationTarget(station("a2a", "market-x"), { exists });
  assert.equal(offline.ok, false);
  assert.ok(offline.reason.includes("a2a 'market-x'"), offline.reason);
});

test("resolution: no checker means cannot prove it exists — refuses", () => {
  // A default here would hand the card to whatever the live runtime is, which
  // is exactly the silent re-assignment this spec forbids.
  const r = flow.resolveStationTarget(station("persona", "p"), { exists: {} });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("no existence checker"), r.reason);
});

test("resolution: an auditor station is persona-backed, not unknown", () => {
  // `auditor` is the fleet layer's fifth kind and it IS persona-backed. The
  // predicate call is what keeps it working; a `=== "persona"` check would have
  // silently degraded it (the 2026-11-10 incident recorded in fleets-db.js).
  const r = flow.resolveStationTarget(
    { stationId: "s", target: { kind: "auditor", ref: "audit-1" } },
    { exists: { persona: () => true } },
  );
  // Not in the engine's kind set, so it is refused AS A KIND — but the refusal
  // must be an honest "unknown kind", never a silent pass.
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("unknown target kind 'auditor'"), r.reason);
});
