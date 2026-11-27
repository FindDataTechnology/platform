// Declaration coherence gate: a pack's skills must not name a tool the pack
// does not grant. Proven in BOTH directions on the two real trading packs, so
// the gate cannot be permanent-green:
//   ① the shipped manifests pass (green segment);
//   ② removing one granted tool from a copy makes it fail, naming the skill+tool
//     (red segment — the two log lines are the 先红后绿 evidence).
// Self-test: node scripts/test-pack-tool-declaration-coherence.mjs --self-test
//   reconstructs the pre-fix 16/19 face of 柏讯·模拟交易套件, expects RED, then
//   expects the shipped manifest GREEN — offline, no registry.
// Run: node --test scripts/test-pack-tool-declaration-coherence.mjs
// workspace-only: needs finddata/docs — the two shipped manifests this gate
// proves on live in the authoring workspace's docs/wire-presets, which the
// single-repo CI checkout does not carry (declared so the shard drops the file
// and NAMES it, instead of failing it for a sibling that cannot exist there).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  skillDeclarationErrors,
  skillsNamedToolsByServer,
  namedMcpTools,
  toolClosureErrors,
} from "../lib/publish-tool-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PACKS = [
  path.join(ROOT, "..", "docs", "wire-presets", "pack-manifests", "wire-paper-trading.json"),
  path.join(ROOT, "..", "docs", "wire-presets", "pack-manifests", "wire-strategy-lab.json"),
];

const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

test("shipped trading packs are coherent", () => {
  for (const p of PACKS) {
    const { errors } = skillDeclarationErrors(load(p));
    assert.deepEqual(errors, [], `${path.basename(p)} should have no incoherence`);
    console.log(`[coherence: green] ${path.basename(p)}: 0 violations`);
  }
});

test("removing one granted tool makes the gate fail and names it", () => {
  for (const p of PACKS) {
    const m = load(p);
    // Find a tool some skill actually names, on a server this pack grants.
    const named = namedMcpTools(m);
    let victim = null;
    for (const [server, tools] of named) {
      const ref = m.mcpServers.find((r) => r.registryName === server);
      if (!ref || !Array.isArray(ref.allowTools)) continue;
      for (const tool of tools.keys()) {
        if (ref.allowTools.includes(tool)) { victim = { server, tool, ref }; break; }
      }
      if (victim) break;
    }
    assert.ok(victim, `${path.basename(p)}: no grant to remove for the reverse test`);

    const broken = clone(m);
    const ref = broken.mcpServers.find((r) => r.registryName === victim.server);
    ref.allowTools = ref.allowTools.filter((t) => t !== victim.tool);

    const { errors } = skillDeclarationErrors(broken);
    assert.ok(errors.length > 0, "removing a granted, skill-named tool must fail");
    assert.ok(
      errors.some((e) => e.entry.includes(`${victim.server}__${victim.tool}`)),
      `the error must name ${victim.server}__${victim.tool}, got ${JSON.stringify(errors)}`
    );
    console.log(`[coherence: red] ${path.basename(p)} without '${victim.tool}': ${errors.length} violation(s) — ${errors[0].error}`);
  }
});

test("an explicit mcp__server__tool name alone is reconciled", () => {
  const m = {
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["a_tool"] }],
    skills: [{ name: "k", content: "call mcp__srv__other_tool directly\n" }],
  };
  const { errors } = skillDeclarationErrors(m);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "skill_names_ungranted_tool");
  assert.ok(errors[0].entry.includes("srv__other_tool"));
});

test("the slash-run shorthand is parsed, not just the explicit name", () => {
  // This is the exact shape that hid `stop_strategy`: explicit first name, then a run.
  const m = {
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["list_strategy_templates"] }],
    skills: [{
      name: "k",
      content: "  mcp__srv__list_strategy_templates / create_strategy / stop_strategy（做点什么）;\n",
    }],
  };
  const { errors } = skillDeclarationErrors(m);
  const named = [...namedMcpTools(m).get("srv").keys()].sort();
  assert.deepEqual(named, ["create_strategy", "list_strategy_templates", "stop_strategy"]);
  assert.equal(errors.length, 2, "both un-granted names in the run must be reported");
});

test("one skill naming tools on two servers checks each against its own face", () => {
  const m = {
    name: "t",
    mcpServers: [
      { registryName: "alpha", allowTools: ["a1"] },
      { registryName: "beta", allowTools: ["b1"] },
    ],
    skills: [{
      name: "k",
      content: "use mcp__alpha__a1 and mcp__beta__b1 (both granted); mcp__alpha__a2 is not\n",
    }],
  };
  const { errors } = skillDeclarationErrors(m);
  assert.equal(errors.length, 1, "only the un-granted alpha tool fails");
  assert.ok(errors[0].entry.includes("alpha__a2"), JSON.stringify(errors));
});

test("a run ending at a new mcp__ reference does not absorb it as a leaf", () => {
  // Real skill shape (2026-11-26): `__tool / mcp__other-server__tool` — the run
  // parser used to swallow `mcp__fd` as a bogus leaf of the FIRST server, which
  // falsely red-flagged 18 of 39 shipped packs when the gate went to enforce.
  const m = {
    name: "t",
    mcpServers: [
      { registryName: "alpha", allowTools: ["a1"] },
      { registryName: "beta", allowTools: ["b1"] },
    ],
    skills: [{ name: "k", content: "  mcp__alpha__a1 / mcp__beta__b1\n" }],
  };
  const { calls } = skillsNamedToolsByServer(m);
  assert.deepEqual([...calls.get("alpha").keys()], ["a1"], "alpha must not gain a bogus mcp__fd-style leaf");
  assert.deepEqual([...calls.get("beta").keys()], ["b1"], "beta's own reference is recorded under beta");
  assert.deepEqual(skillDeclarationErrors(m).errors, [], "both tools are granted — no false violation");
});

test("naming a server the pack does not carry fails", () => {
  const m = {
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["a"] }],
    skills: [{ name: "k", content: "call mcp__ghost__b\n" }],
  };
  const { errors } = skillDeclarationErrors(m);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "skill_names_absent_server");
});

test("a fenced example never fails the publish — it warns it was not reconciled", () => {
  const m = {
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["a_tool"] }],
    skills: [{
      name: "k",
      content: "```\nmcp__srv__a_tool / not_a_real_tool\n```\nprose: mcp__srv__a_tool\n",
    }],
  };
  const { errors, warnings } = skillDeclarationErrors(m);
  assert.deepEqual(errors, [], "a fenced example's run must not fail the publish");
  // The fenced explicit name is collected (as an example); the run is never absorbed.
  assert.deepEqual([...namedMcpTools(m).get("srv").keys()], ["a_tool"]);
  assert.equal(warnings.length, 1, "the fenced hit warns it was not counted");
  assert.equal(warnings[0].code, "skill_names_in_fence");
  assert.ok(warnings[0].error.includes("NOT reconciled"), warnings[0].error);

  const ungranted = skillDeclarationErrors({
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["a_tool"] }],
    skills: [{ name: "k", content: "```\nmcp__srv__unknown_tool\n```\n" }],
  });
  assert.deepEqual(ungranted.errors, [], "a fenced UN-GRANTED name must not fail the publish");
  assert.equal(ungranted.warnings.length, 1);
  assert.equal(ungranted.warnings[0].code, "skill_names_in_fence");
});

test("toolClosureErrors keeps its pack-authoring semantics: a fenced un-granted name still fails THAT check", () => {
  // The older closure (pack-authoring) has no fence exemption; only the
  // coherence gate warns. Guarded here so the two cannot silently converge.
  const m = {
    name: "t",
    mcpServers: [{ registryName: "srv", allowTools: ["a_tool"] }],
    skills: [{ name: "k", content: "```\nmcp__srv__unknown_tool\n```\n" }],
  };
  assert.equal(toolClosureErrors(m).length, 1);
});

// ── --self-test: 先红后绿 on the real pack, offline ──────────────────────────
// Reconstructs the pre-fix face of 柏讯·模拟交易套件 (the three tools its skills
// named but its allowTools omitted) and expects the gate to judge it RED;
// then expects the shipped (补齐后) manifest GREEN. Exit 0 iff both match.
if (process.argv[2] === "--self-test") {
  const shipped = load(PACKS[0]);
  const ref = shipped.mcpServers.find((r) => r.registryName === "fd-paper-trading");
  // The three names that were the defect (2026-11-25: 16/19 declared).
  const PRE_FIX_MISSING = ["get_strategy", "list_strategy_runs", "stop_strategy"];
  const preFix = clone(shipped);
  const preFixRef = preFix.mcpServers.find((r) => r.registryName === "fd-paper-trading");
  preFixRef.allowTools = preFixRef.allowTools.filter((t) => !PRE_FIX_MISSING.includes(t));

  const red = skillDeclarationErrors(preFix);
  const redOk = red.errors.length > 0
    && red.errors.some((e) => PRE_FIX_MISSING.some((t) => e.entry.includes(`fd-paper-trading__${t}`)));
  console.log(`[self-test: red] 模拟交易套件 现状 (16/19): ${red.errors.length} violation(s)`);
  for (const e of red.errors.slice(0, 4)) console.log(`  - ${e.error}`);
  if (!redOk) console.log("  ✗ the pre-fix face did NOT come back red");

  const green = skillDeclarationErrors(shipped);
  console.log(`[self-test: green] 模拟交易套件 补齐后 (${ref.allowTools.length}/19): ${green.errors.length} violation(s)`);
  if (green.errors.length !== 0) console.log(`  ✗ shipped manifest judged red: ${JSON.stringify(green.errors)}`);

  const bad = (redOk ? 0 : 1) + (green.errors.length === 0 ? 0 : 1);
  console.log(bad === 0 ? "\nself-test 全过（先红后绿）" : `\nself-test ${bad} 段不符`);
  process.exit(bad === 0 ? 0 : 1);
}
