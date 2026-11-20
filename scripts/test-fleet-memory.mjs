#!/usr/bin/env node
// ── Fleet working memory tests (add-zhiyu-team-memory 刀A;
// add-member-knowledge-profile capture split) ───────────────────────────────
//
// Pins:
//   - the capture wrapper: five fact kinds route by the closed own/shared map
//     (turn/health → own, decision-*/swap → shared) with the metadata triple;
//     titles stay human (no machine prefix). Replay dedupe and the counter-
//     not-throw failure contract are inherited and re-asserted.
//   - the health-flip tracker: emits only on ok↔failed transitions
//   - the fleetContext memory section: present when the provider returns a
//     block, ABSENT on null/throw (never a placeholder, never a failed render),
//     truncation order — the memory section is the FIRST to yield the pool
//   - the project id namespace: `f/<id>`, sanitized
//
//   node --test scripts/test-fleet-memory.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  fleetProjectId,
  createFleetMemoryCapture,
  createHealthFlipTracker,
} = await import("@finddatatechnology/yongyi-client");

function fakeMemory() {
  const facts = [];
  return {
    facts,
    async writeFact(f) {
      facts.push(f);
      return { ok: true };
    },
  };
}

test("project id: f/ namespace, path-sanitized", () => {
  assert.equal(fleetProjectId("fleet_abc"), "f/fleet_abc");
  assert.equal(fleetProjectId("../evil"), "f/..-evil");
  assert.equal(fleetProjectId(""), "f/unknown");
});

test("capture: five kinds route by the closed map (own/shared) with the metadata triple", async () => {
  const mem = fakeMemory();
  const cap = createFleetMemoryCapture({ memory: mem, clock: () => 1000 });
  const f = "fleet_1";
  await cap.capture(f, "m1", "turn", "回合成功", "报数 309");
  await cap.capture(f, "m1", "decision-opened", "续约供应商？", "严重度 high");
  await cap.capture(f, "m1", "decision-resolved", "续约供应商？", "批准");
  await cap.capture(f, "m2", "health", "状态迁移 → failed", "连续失败");
  await cap.capture(f, "m1", "swap", "岗位「电商部」换防", "新在岗者 persona-b");
  assert.equal(mem.facts.length, 5);
  // 岗位私有 (turn/health) → own; 团队事实 (decision-*/swap) → shared
  assert.deepEqual(mem.facts.filter((x) => x.partition === "own").map((x) => x.kind).sort(), ["health", "turn"]);
  assert.deepEqual(mem.facts.filter((x) => x.partition === "shared").map((x) => x.kind).sort(), ["decision-opened", "decision-resolved", "swap"]);
  // the identity triple rides every fact (the client layer turns it into
  // first-class page metadata), human titles
  for (const x of mem.facts) {
    assert.equal(x.fleetId, f);
    assert.ok(x.memberId && x.kind);
    assert.ok(!/^\[/.test(x.title), "no machine prefix on titles");
  }
});

test("capture: same-second replay dedupes; a failing write is a counter, never a throw", async () => {
  let failing = false;
  const mem = fakeMemory();
  const orig = mem.writeFact.bind(mem);
  mem.writeFact = async (...a) => {
    if (failing) throw new Error("pages HTTP 503");
    return orig(...a);
  };
  const cap = createFleetMemoryCapture({ memory: mem, clock: () => 1000 });
  await cap.capture("fleet_1", "m1", "turn", "t", "b");
  await cap.capture("fleet_1", "m1", "turn", "t", "b");
  assert.equal(mem.facts.length, 1, "replay within the dedupe window lands once");
  assert.equal(cap.captured, 1);

  failing = true;
  const r = await cap.capture("fleet_1", "m1", "turn", "t2", "b");
  assert.equal(r, false, "capture returns false, does not throw");
  assert.equal(cap.failures, 1, "the failure is a counter");
});

test("health flips: only ok↔failed transitions emit", () => {
  const flip = createHealthFlipTracker();
  assert.equal(flip("f", "m", "ok"), false, "first observation is not a flip");
  assert.equal(flip("f", "m", "ok"), false);
  assert.equal(flip("f", "m", "failed"), true, "ok→failed flips");
  assert.equal(flip("f", "m", "failed"), false);
  assert.equal(flip("f", "m", "ok"), true, "failed→ok flips (recovery)");
});

// ── fleetContext section (the seam contract) ────────────────────────────────

const fc = await import("../server/fleet-context.js");
const core = await import("../server/routes/fleets-db.js");
const path = await import("node:path");
const os = await import("node:os");
const fs = await import("node:fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mem-ctx-"));
const db = core.createFleetDatabase({ file: path.join(tmp, "fleets.db") });
const fleet = db.createFleet({ id: "fleet_ctx", name: "客服班组", ownerEmail: "o@x" });
db.createMember({
  id: "m_lead", fleetId: fleet.id, title: "客服组长", parentId: null,
  targetKind: "persona", targetId: "p1", kpiSlots: [], cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true },
});

const deps = (over = {}) => ({
  db,
  deriveStatuses: () => new Map([["m_lead", "on_duty"]]),
  decisionDigest: () => null,
  ...over,
});

test("fleetContext: memory section present when the provider returns a block", async () => {
  const out = await fc.buildFleetContext({ fleetId: fleet.id, memberId: "m_lead" }, null, deps({
    memoryDigest: async () => "• [turn] 昨日处理 12 单\n• [decision] 报销政策已批准",
  }));
  assert.match(out, /【记忆与知识】/);
  assert.match(out, /昨日处理 12 单/);
  assert.match(out, /巡逻纪律/, "the discipline trailer still rides");
});

test("fleetContext: null or throwing provider = section absent, render still succeeds", async () => {
  const nullOut = await fc.buildFleetContext({ fleetId: fleet.id, memberId: "m_lead" }, null, deps({
    memoryDigest: async () => null,
  }));
  assert.doesNotMatch(nullOut, /工作记忆/);
  const throwOut = await fc.buildFleetContext({ fleetId: fleet.id, memberId: "m_lead" }, null, deps({
    memoryDigest: async () => {
      throw new Error("digest HTTP 503");
    },
  }));
  assert.doesNotMatch(throwOut, /工作记忆/);
  assert.match(throwOut, /巡逻纪律/, "a memory hiccup never fails the firing");
});

test("fleetContext: a bloated memory block truncates, the section still rides", async () => {
  const out = await fc.buildFleetContext({ fleetId: fleet.id, memberId: "m_lead" }, null, deps({
    memoryDigest: async () => "x".repeat(10 * 1024),
  }));
  assert.match(out, /【记忆与知识】/);
  assert.match(out, /\[截断\]/, "the oversized block is truncated with the standard mark");
});
