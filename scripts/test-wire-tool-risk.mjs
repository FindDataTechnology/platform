// Unit tests — wire tool-risk reconciliation (add-wire-line-board, design D2).
// Run: node --test scripts/test-wire-tool-risk.mjs
//
//   Test A (CI hard gate): every wire action in lib/action-registry.js names the
//     tool the snapshot maps it to and carries exactly the snapshot's risk; the
//     snapshot covers all 14 write tools (12 + 源包订阅/退订,
//     add-pack-subscribe-actions); the risk→tier map is byte-identical
//     to fd-wire's RISK_TO_TIER.
//   Test B (local gate): when the wire-ops-mcp / wire-build-mcp checkouts are
//     present, their tool-surface.json `tool_risk` equals the snapshot. Skips
//     (loudly) when the checkouts are absent — CI has none.
//
// Mutation check (manual): flip one risk in lib/action-registry.js and A must
// fail naming the entry; flip one in a checkout and B must fail naming the tool.

import test from "node:test";
import assert from "node:assert/strict";

const registry = await import("../lib/action-registry.js");
const snapshot = await import("../lib/wire-tool-risk.js");
const refresh = await import("./refresh-wire-tool-surface.mjs");

const EXPECTED_WIRE_ACTIONS = [
  "wire.demand.submit",
  "wire.market.subscribe",
  "wire.market.unsubscribe",
  "wire.pack.subscribe",
  "wire.pack.unsubscribe",
  "wire.dataset.create",
  "wire.artifact.publish",
  "wire.artifact.archive",
  "wire.dataset.correct",
  "wire.dataset.correction.revert",
];

test("A: the eight wire actions exist, line=wire, and match the snapshot tool + risk", () => {
  const wire = registry.listActions({ line: "wire" });
  assert.deepEqual(wire.map((a) => a.id).sort(), [...EXPECTED_WIRE_ACTIONS].sort());
  const mismatches = [];
  for (const action of wire) {
    const expectedTool = snapshot.toolForAction(action.id);
    if (action.tool !== expectedTool) {
      mismatches.push(`${action.id}: registry tool "${action.tool}" ≠ snapshot "${expectedTool}"`);
      continue;
    }
    const expectedRisk = snapshot.riskForTool(action.tool);
    if (action.risk !== expectedRisk) {
      mismatches.push(`${action.id}: registry risk "${action.risk}" ≠ tool_risk "${expectedRisk}" (${action.tool})`);
    }
    assert.equal(action.target, "cloud", `${action.id} target`);
    assert.equal(typeof action.preflight, "function", `${action.id} preflight`);
  }
  assert.deepEqual(mismatches, [], `risk/tool drift:\n  ${mismatches.join("\n  ")}`);
});

test("A: snapshot covers exactly the 18 declared gated tools and every action tool is one of them", () => {
  // 18 = 16 write + 源包订阅 wire_market_subscribe (risk `cost`, still gated)
  //      + wire_self_action_propose (自域动作提议, wire-ops-mcp). The two read
  //      names the same surface declares (wire_self_action_list/status) are
  //      mirrored in WIRE_TOOL_RISK but must NOT be in the gate.
  assert.equal(snapshot.WIRE_WRITE_TOOLS.length, 18, "gated-tool universe size (12 + add-pack-subscribe-actions + add-wire-artifact-build-surface + wire-domain-actions + self-actions)");
  assert.deepEqual(
    snapshot.WIRE_WRITE_TOOLS.filter((tool) => snapshot.riskForTool(tool) === "read"),
    [],
    "read never enters the gate — a read face must stay allowed in a copilot pack",
  );
  assert.deepEqual(snapshot.WIRE_WRITE_TOOLS, [...snapshot.WIRE_WRITE_TOOLS].sort(), "sorted");
  for (const [action, tool] of Object.entries(snapshot.WIRE_ACTION_TOOLS)) {
    assert.ok(snapshot.isWireWriteTool(tool), `${action} → ${tool} missing from tool_risk`);
    assert.equal(snapshot.WIRE_TOOL_RISK[tool].server === "wire-ops-mcp" || snapshot.WIRE_TOOL_RISK[tool].server === "wire-build-mcp", true);
  }
  // Deliberate gap, pinned so a future "helpful" refresh cannot close it:
  // wire_action_propose IS in the write universe (a pack declaring it cannot
  // become a focused copilot face), but it has NO paas action-registry entry.
  // Registering it would grow a second confirmation face for domain actions —
  // the cross-line ruling forbids that (wire-domain-actions R2,
  // docs/wire-domain-actions-paas-review.md §三): the confirm card lives in the
  // wire console, exactly once. The read pair stays outside the gate entirely.
  assert.equal(snapshot.isWireWriteTool("wire_action_propose"), true, "propose is a gated write tool");
  assert.equal(snapshot.toolForAction("wire.action.propose"), null, "propose has no paas action id");
  assert.equal(registry.listActions({ line: "wire" }).some((a) => a.tool === "wire_action_propose"), false, "no wire action names propose");
  assert.equal(snapshot.isWireWriteTool("wire_action_list"), false, "action_list is read");
  assert.equal(snapshot.isWireWriteTool("wire_action_status"), false, "action_status is read");
  // The script's authored mapping and the generated module must agree.
  assert.deepEqual(snapshot.WIRE_ACTION_TOOLS, refresh.WIRE_ACTION_TOOLS);
});

test("A: risk → tier is byte-identical to fd-wire RISK_TO_TIER (read stays out of the gate)", () => {
  const tiers = registry.riskToTierMap();
  assert.equal(tiers.write, "inline");
  assert.equal(tiers.destructive, "second");
  assert.equal(tiers.cost, "second");
  assert.equal(tiers.publish, "async");
  assert.equal(registry.tierForRisk("read"), "auto");
  // Every wire risk value is one the tier map knows.
  for (const tool of snapshot.WIRE_WRITE_TOOLS) {
    assert.ok(tiers[snapshot.riskForTool(tool)], `${tool} risk "${snapshot.riskForTool(tool)}" has no tier`);
  }
});

test("A: wire.demand.submit declares the two compliance fields as user-filled (fd-wire DemandCreate names)", () => {
  const schema = registry.userFilledArgsFor("wire.demand.submit");
  assert.deepEqual(
    schema.map((f) => [f.key, f.kind, f.required]),
    [
      ["source_urls", "url[]", true],
      ["public_data_asserted", "boolean", true],
    ],
  );
  for (const id of EXPECTED_WIRE_ACTIONS.filter((x) => x !== "wire.demand.submit")) {
    assert.deepEqual(registry.userFilledArgsFor(id), [], `${id} should declare no user-filled args`);
  }
});

test("A: existing facet/wanxing roster is untouched by the wire additions", () => {
  assert.equal(registry.listActions({ line: "facet" }).length, 4);
  assert.equal(registry.listActions({ line: "wanxing" }).length, 5);
  // 19 = facet 4 + wanxing 5 + wire 10 (pre-crm); crm.message.send (add-crm-desk-bridge) is the 20th.
  assert.equal(registry.listActions({ line: "crm" }).length, 1);
  assert.equal(registry.listActions().length, 20);
});

test("B: source tool-surface.json tool_risk equals the vendored snapshot (skips without checkouts)", (t) => {
  const { tools, missing } = refresh.readSourceToolRisk();
  if (missing.length) {
    t.diagnostic(`SKIP: no checkout for ${missing.join(", ")} (set WIRE_OPS_MCP_DIR / WIRE_BUILD_MCP_DIR to run)`);
    t.skip("wire MCP checkouts not present");
    return;
  }
  const drift = [];
  const sourceNames = Object.keys(tools).sort();
  for (const name of new Set([...sourceNames, ...snapshot.WIRE_WRITE_TOOLS])) {
    const src = tools[name];
    const snap = snapshot.WIRE_TOOL_RISK[name];
    if (!src) drift.push(`${name}: in snapshot, not in any source tool_risk`);
    else if (!snap) drift.push(`${name}: in ${src.server} tool_risk, not in snapshot`);
    else if (src.risk !== snap.risk || src.server !== snap.server) {
      drift.push(`${name}: source ${src.server}/${src.risk} ≠ snapshot ${snap.server}/${snap.risk}`);
    }
  }
  assert.deepEqual(drift, [], `snapshot drift — run scripts/refresh-wire-tool-surface.mjs:\n  ${drift.join("\n  ")}`);
  // And the rendered module is what the script would write today.
  assert.equal(`${refresh.renderSnapshot(tools)}\n`, refresh.currentSnapshot());
});
