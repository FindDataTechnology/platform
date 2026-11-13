// add-pack-memory-declaration: the read axis spoke two spellings (`memory` from
// add-member-knowledge-profile, `read` from the four-axis vocabulary) and two
// switches (`enabled`, `scope`) that could disagree. This file pins the rules
// that removed both ambiguities.
//
// Every negative case asserts the SPECIFIC code and path — "returns ok:false"
// lets a wrong rejection pass as a right one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_DEFAULTS,
  describeKnowledgeProfile,
  effectiveProfile,
  normalizeKnowledgeProfile,
} from "../server/knowledge-profile.js";

const codes = (res) => res.errors.map((e) => e.code);
const paths = (res) => res.errors.map((e) => e.path);

// ── two spellings, one axis ────────────────────────────────────────────────

test("read is accepted as a spelling of the same axis", () => {
  const res = normalizeKnowledgeProfile({ read: { scope: "shared", budget: 800 } });
  assert.equal(res.ok, true);
  assert.equal(res.profile.memory.scope, "shared");
  assert.equal(res.profile.memory.budget, 800);
});

test("agreeing spellings are accepted and normalize identically", () => {
  const viaMemory = normalizeKnowledgeProfile({ memory: { scope: "shared", budget: 800 } });
  const viaRead = normalizeKnowledgeProfile({ read: { scope: "shared", budget: 800 } });
  assert.deepEqual(viaMemory.profile, viaRead.profile);
});

test("disagreeing spellings are rejected, naming both", () => {
  const res = normalizeKnowledgeProfile({
    memory: { scope: "shared" },
    read: { scope: "own+shared" },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res), ["read_memory_conflict"]);
  assert.deepEqual(paths(res), ["read.scope"]);
  const message = res.errors[0].message;
  assert.match(message, /shared/);
  assert.match(message, /own\+shared/);
  assert.match(message, /must agree/);
});

test("each key is compared on its own: agreement on one does not excuse the other", () => {
  const res = normalizeKnowledgeProfile({
    memory: { scope: "shared", budget: 800 },
    read: { scope: "shared", budget: 900 },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(paths(res), ["read.budget"]);
});

test("a key only one spelling mentions is not a conflict", () => {
  const res = normalizeKnowledgeProfile({ memory: { scope: "shared" }, read: { budget: 900 } });
  assert.equal(res.ok, true);
  assert.equal(res.profile.memory.scope, "shared");
  assert.equal(res.profile.memory.budget, 900);
});

test("read validates its keys like memory does", () => {
  const bad = normalizeKnowledgeProfile({ read: { budgt: 800 } });
  assert.deepEqual(codes(bad), ["unknown_key"]);
  assert.deepEqual(paths(bad), ["read.budgt"]);

  const outOfRange = normalizeKnowledgeProfile({ read: { budget: 4000 } });
  assert.deepEqual(codes(outOfRange), ["memory_budget_invalid"]);
  assert.deepEqual(paths(outOfRange), ["read.budget"]);

  const badScope = normalizeKnowledgeProfile({ read: { scope: "private" } });
  assert.deepEqual(codes(badScope), ["memory_scope_invalid"]);
});

test("a non-object read segment is named as read, not as memory", () => {
  const res = normalizeKnowledgeProfile({ read: "shared" });
  assert.deepEqual(codes(res), ["read_invalid"]);
  assert.match(res.errors[0].message, /knowledge\.read must be an object/);
});

// ── one switch, one verdict ────────────────────────────────────────────────

test("enabled:false canonicalizes to scope off", () => {
  const res = normalizeKnowledgeProfile({ memory: { enabled: false } });
  assert.equal(res.ok, true);
  assert.equal(res.profile.memory.scope, "off");
  assert.equal(res.profile.memory.enabled, false);
});

test("scope off canonicalizes to enabled:false", () => {
  const res = normalizeKnowledgeProfile({ memory: { scope: "off" } });
  assert.equal(res.ok, true);
  assert.equal(res.profile.memory.enabled, false);
});

test("a contradictory pair resolves to off, never to on", () => {
  // enabled=true with scope=off: the consumer that checked scope said off, the
  // one that checked enabled said on. Resolving to the stricter reading removes
  // the disagreement instead of betting on which check runs first.
  const a = normalizeKnowledgeProfile({ memory: { enabled: true, scope: "off" } });
  assert.equal(a.ok, true);
  assert.equal(a.profile.memory.enabled, false);
  assert.equal(a.profile.memory.scope, "off");

  const b = normalizeKnowledgeProfile({ memory: { enabled: false, scope: "own+shared" } });
  assert.equal(b.ok, true);
  assert.equal(b.profile.memory.scope, "off");
});

test("the defaults stay a coherent pair", () => {
  const res = normalizeKnowledgeProfile(null);
  assert.equal(res.profile.memory.enabled, true);
  assert.notEqual(res.profile.memory.scope, "off");
  assert.deepEqual(res.profile, KNOWLEDGE_DEFAULTS);
});

// ── effectiveProfile: either spelling overrides the axis ───────────────────

test("a deployment writing read overrides a cell writing memory", () => {
  const res = effectiveProfile(
    { memory: { scope: "own+shared", budget: 900 } },
    { read: { scope: "shared" } },
  );
  assert.equal(res.ok, true);
  assert.equal(res.profile.memory.scope, "shared");
  // Wholesale replacement of the segment: budget falls back to the PLATFORM
  // default, never to the cell's value (documented merge contract).
  assert.equal(res.profile.memory.budget, KNOWLEDGE_DEFAULTS.memory.budget);
});

// ── four columns ───────────────────────────────────────────────────────────

test("declared, inherited-from, effective and executed are reported per sub-key", () => {
  const res = describeKnowledgeProfile({
    cellDefault: { memory: { scope: "shared" } },
    deploymentOverride: { read: { budget: 700 } },
  });
  assert.equal(res.ok, true);
  // The deployment mentioned the read segment, so the whole segment was replaced
  // and the cell's `scope` never carried over. The table says so (shadowed_by)
  // instead of claiming the cell's value is in force.
  assert.deepEqual(res.rows["read.scope"], {
    declared: "shared",
    inherited_from: "platform",
    effective: "own+shared",
    executed: true,
    shadowed_by: "deployment",
  });
  assert.deepEqual(res.rows["read.budget"], {
    declared: 700,
    inherited_from: "deployment",
    effective: 700,
    executed: true,
  });
});

test("a default-filled value never looks like a declaration", () => {
  const res = describeKnowledgeProfile({});
  assert.equal(res.rows["read.scope"].declared, null);
  assert.equal(res.rows["read.scope"].inherited_from, "platform");
  assert.equal(res.rows["read.scope"].effective, KNOWLEDGE_DEFAULTS.memory.scope);
});

test("an explicitly-declared default is distinguishable from an absence", () => {
  const declared = describeKnowledgeProfile({
    deploymentOverride: { memory: { budget: KNOWLEDGE_DEFAULTS.memory.budget } },
  });
  assert.equal(declared.rows["read.budget"].declared, KNOWLEDGE_DEFAULTS.memory.budget);
  assert.equal(declared.rows["read.budget"].inherited_from, "deployment");

  const absent = describeKnowledgeProfile({});
  assert.equal(absent.rows["read.budget"].declared, null);
});

test("a bad declaration is reported, never masked by a default", () => {
  const res = describeKnowledgeProfile({ deploymentOverride: { read: { scope: "nonsense" } } });
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res), ["memory_scope_invalid"]);
  assert.equal(res.rows, undefined, "no rows on error: a default-filled table would read as valid");
});

test("own-only is refused because no consumer can express it", () => {
  // yongyi-client's readDigest branches on `scope === "own+shared"` only, so a
  // declared `own` would skip the own probe and still read shared — a silent
  // wrong reading. The enum stops short of what the declaration face can say.
  const res = normalizeKnowledgeProfile({ read: { scope: "own" } });
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res), ["memory_scope_invalid"]);
  assert.match(res.errors[0].message, /own\+shared/);
});

// ── agent level: per-key, above the wholesale pair ─────────────────────────

test("an agent declaration wins the keys it names and inherits the rest", () => {
  const res = describeKnowledgeProfile({
    agentMemory: { budget: 640 },
    cellDefault: { memory: { scope: "shared", budget: 900 } },
  });
  assert.equal(res.rows["read.budget"].declared, 640);
  assert.equal(res.rows["read.budget"].inherited_from, "agent");
  assert.equal(res.rows["read.budget"].effective, 640);
  // Not named by the agent → inherited from the cell, not reset.
  assert.equal(res.rows["read.scope"].inherited_from, "cell");
  assert.equal(res.rows["read.scope"].effective, "shared");
});

test("the agent level is not a participant in the wholesale replacement", () => {
  // The deployment mentioning the segment drops the CELL's segment wholesale, but
  // a role's own declaration must survive: it is a per-key level above the pair.
  const res = describeKnowledgeProfile({
    agentMemory: { budget: 700 },
    cellDefault: { memory: { scope: "shared", budget: 900 } },
    deploymentOverride: { memory: { scope: "off" } },
  });
  assert.equal(res.rows["read.budget"].effective, 700);
  assert.equal(res.rows["read.budget"].inherited_from, "agent");
  assert.equal(res.rows["read.budget"].shadowed_by, undefined);
  // The cell's scope still lost to the deployment's segment.
  assert.equal(res.rows["read.scope"].declared, "off");
  assert.equal(res.rows["read.scope"].inherited_from, "deployment");
});

test("agent memory may be written as the four-axis block or as the bare segment", () => {
  const bare = describeKnowledgeProfile({ agentMemory: { scope: "shared" } });
  const blocked = describeKnowledgeProfile({ agentMemory: { read: { scope: "shared" } } });
  assert.deepEqual(bare.rows["read.scope"], blocked.rows["read.scope"]);
  assert.equal(blocked.rows["read.scope"].declared, "shared");
});

test("declared reflects the raw spelling even when the other one wins the merge", () => {
  // The cell wrote `read`, the deployment wrote `memory`: the deployment wins the
  // value, and `declared` still reports what was actually written there.
  const res = describeKnowledgeProfile({
    cellDefault: { read: { scope: "off" } },
    deploymentOverride: { memory: { scope: "shared" } },
  });
  assert.equal(res.rows["read.scope"].declared, "shared");
  assert.equal(res.rows["read.scope"].inherited_from, "deployment");
  assert.equal(res.rows["read.scope"].effective, "shared");
});
