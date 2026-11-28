// standard-preset persona contract (add-team-building-first-run 2.1 / 2.2).
//
// The platform's default expert is a coding agent AND a builder. Both halves
// are load-bearing:
//   · the coding-agent base line must stay verbatim (a deployment that renamed
//     the assistant must not change what the runtime IS);
//   · the building discipline must name the three actual tools and the
//     approval gate, because the failure this change fixes was "the tools were
//     there, nothing told the model it may use them".
//
// The row is data in the shipped composition, so this reads the composition the
// way the profile writer does (same source file, same YAML load), not a copy.
//
// Run: node --test scripts/test-standard-persona.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const SOURCE = new URL("../dsh-profile-template/standard.agent.cordis.yml", import.meta.url);

function personaPrefix() {
  const rows = yaml.load(readFileSync(SOURCE, "utf8"));
  const row = rows.find((r) => r && typeof r === "object" && r.id === "persona");
  assert.ok(row, "the composition has a persona row");
  return row.config?.prefix ?? "";
}

test("the coding-agent base line is unchanged", () => {
  const prefix = personaPrefix();
  assert.ok(
    prefix.startsWith("You are a coding agent powered by the {{model}} model."),
    "the original base line must remain the first sentence, verbatim",
  );
  // 0.2.2 registers only provider/model as prompt variables and interpolates
  // strictly: a {{cwd}} reference fails every turn at prompt assembly (the
  // agent runs to idle without ever calling the model). The working directory
  // reaches the model through the runtime context instead.
  assert.ok(!prefix.includes("{{cwd}}"), "persona must not reference {{cwd}} — 0.2.2 rejects the variable");
});

test("the building discipline names the three real tools", () => {
  const prefix = personaPrefix();
  for (const tool of ["fleet_draft", "fleet_apply", "pack_market_servers", "pack_validate", "pack_save"]) {
    assert.ok(prefix.includes(tool), `the persona must name '${tool}' — it is what makes the capability reachable`);
  }
});

test("the discipline states the approval gate and the paused birth", () => {
  const prefix = personaPrefix();
  assert.match(prefix, /approv/i, "approval is the gate for every write");
  assert.match(prefix, /all-paused|all paused/i, "a created team is born paused");
  assert.match(prefix, /never publish|not publish/i, "publishing is the owner's action, not the model's");
});

test("the discipline is scoped to an explicit request", () => {
  // The paragraph must not turn every turn into a build. It opens by naming
  // the trigger ("also build things the user asks for") and the routing is
  // quoted from the user's own words.
  const prefix = personaPrefix();
  assert.match(prefix, /asks for/i, "the paragraph is scoped to an explicit ask");
  assert.ok(prefix.includes("我要一支团队"), "routing keys off the user's words");
});

test("the added discipline stays bounded in size", () => {
  // Persona text is prompt budget on every turn. ≤ 10 added non-empty lines
  // past the base sentence (task 2.2's ceiling).
  const prefix = personaPrefix();
  const base = "You are a coding agent powered by the {{model}} model.";
  const added = prefix.slice(base.length).split("\n").filter((l) => l.trim());
  assert.ok(added.length <= 10, `added lines = ${added.length}, expected ≤ 10`);
});
