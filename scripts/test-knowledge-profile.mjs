// add-member-knowledge-profile: the member knowledge profile pure module
// (server/knowledge-profile.js) plus its blueprint-validate hook. Zero DB by
// design — collection visibility rides an injected resolveCollection callback,
// and without one only the SHAPE decides (no false rejection, mirroring
// test-blueprint-library-ref.mjs's resolver contract).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_DEFAULTS,
  KNOWLEDGE_SCOPE_VALUES,
  effectiveProfile,
  normalizeKnowledgeProfile,
} from "../server/knowledge-profile.js";
import { knowledgeFindings, validateBlueprint } from "../server/blueprint-validate.js";

// ── Defaults: 缺省即默认 ──────────────────────────────────────────────────────

test("normalize(null) yields the documented defaults", () => {
  const res = normalizeKnowledgeProfile(null);
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile, KNOWLEDGE_DEFAULTS);
  assert.deepEqual(normalizeKnowledgeProfile(undefined).profile, KNOWLEDGE_DEFAULTS);
});

test("defaults are fresh copies — mutating a result never poisons the constants", () => {
  const res = normalizeKnowledgeProfile(null);
  res.profile.memory.enabled = false;
  res.profile.collections.push("library:sneaky");
  assert.equal(normalizeKnowledgeProfile(null).profile.memory.enabled, true);
  assert.deepEqual(normalizeKnowledgeProfile(null).profile.collections, []);
});

test("effectiveProfile(null, null) is the defaults too", () => {
  const res = effectiveProfile(null, null);
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile, KNOWLEDGE_DEFAULTS);
});

test("a fully declared profile round-trips canonically", () => {
  const res = normalizeKnowledgeProfile({
    memory: { enabled: false, scope: "off", budget: 2000 },
    collections: ["library:col-1", "library:col-2"],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile, {
    memory: { enabled: false, scope: "off", budget: 2000 },
    collections: ["library:col-1", "library:col-2"],
  });
});

test("a partial memory segment falls back to defaults per field", () => {
  const res = normalizeKnowledgeProfile({ memory: { budget: 800 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.memory, { enabled: true, scope: "own+shared", budget: 800 });
});

// ── Field-level refusals, each with its code ────────────────────────────────

test("an unknown scope value is refused as memory_scope_invalid", () => {
  const res = normalizeKnowledgeProfile({ memory: { scope: "everything" } });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "memory_scope_invalid");
  assert.equal(res.errors[0].path, "memory.scope");
  assert.match(res.errors[0].message, /own\+shared, shared, off/);
});

test("budget outside 64..2000 (or non-integer) is refused as memory_budget_invalid", () => {
  for (const budget of [0, 63, 2001, 800.5, "800", null]) {
    const res = normalizeKnowledgeProfile({ memory: { budget } });
    assert.equal(res.ok, false, `budget ${JSON.stringify(budget)} should be refused`);
    assert.equal(res.errors[0].code, "memory_budget_invalid");
    assert.equal(res.errors[0].path, "memory.budget");
  }
  assert.equal(normalizeKnowledgeProfile({ memory: { budget: 64 } }).ok, true);
  assert.equal(normalizeKnowledgeProfile({ memory: { budget: 2000 } }).ok, true);
});

test("a non-boolean enabled is refused as memory_enabled_invalid", () => {
  const res = normalizeKnowledgeProfile({ memory: { enabled: "yes" } });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "memory_enabled_invalid");
});

test("a malformed collection ref is refused by index as collection_ref_invalid", () => {
  for (const ref of ["col-123", "library:", "library:has space", `library:${"x".repeat(65)}`, 42]) {
    const res = normalizeKnowledgeProfile({ collections: ["library:ok", ref] });
    assert.equal(res.ok, false, `ref ${JSON.stringify(ref)} should be refused`);
    assert.equal(res.errors[0].code, "collection_ref_invalid");
    assert.equal(res.errors[0].path, "collections[1]");
  }
});

test("unknown keys are refused by name as unknown_key (top level and inside memory)", () => {
  const top = normalizeKnowledgeProfile({ volumes: [], memory: { budget: 800 } });
  assert.equal(top.ok, false);
  assert.equal(top.errors[0].code, "unknown_key");
  assert.equal(top.errors[0].path, "volumes");

  const nested = normalizeKnowledgeProfile({ memory: { budgt: 800 } });
  assert.equal(nested.ok, false);
  assert.equal(nested.errors[0].code, "unknown_key");
  assert.equal(nested.errors[0].path, "memory.budgt");
});

test("wrong segment types are refused (profile_invalid / memory_invalid / collections_invalid)", () => {
  assert.equal(normalizeKnowledgeProfile("nope").errors[0].code, "profile_invalid");
  assert.equal(normalizeKnowledgeProfile([]).errors[0].code, "profile_invalid");
  assert.equal(normalizeKnowledgeProfile({ memory: "off" }).errors[0].code, "memory_invalid");
  assert.equal(normalizeKnowledgeProfile({ collections: "library:x" }).errors[0].code, "collections_invalid");
});

// ── resolveCollection: visibility is the caller's DB-backed fact ────────────

test("an invisible collection is refused BY NAME as collection_unresolved", () => {
  const res = normalizeKnowledgeProfile({ collections: ["library:missing-1"] }, { resolveCollection: (id) => (id === "missing-1" ? "no such collection in this deployment" : true) });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "collection_unresolved");
  assert.equal(res.errors[0].path, "collections[0]");
  assert.match(res.errors[0].message, /library:missing-1/);
  assert.match(res.errors[0].message, /no such collection/);
});

test("a dangling verdict (false) is refused by name too", () => {
  const res = normalizeKnowledgeProfile({ collections: ["library:gone"] }, { resolveCollection: () => false });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "collection_unresolved");
});

test("a visible collection passes resolution", () => {
  const res = normalizeKnowledgeProfile({ collections: ["library:col-ok"] }, { resolveCollection: () => true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.collections, ["library:col-ok"]);
});

test("without a resolver the shape alone decides (no false rejection)", () => {
  const res = normalizeKnowledgeProfile({ collections: ["library:anything-ok"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.collections, ["library:anything-ok"]);
});

test("scope vocabulary is exported for callers to build off", () => {
  assert.deepEqual(KNOWLEDGE_SCOPE_VALUES, ["own+shared", "shared", "off"]);
});

// ── effectiveProfile: 整体替换，不深并 ───────────────────────────────────────

const CELL_STRICT = { memory: { enabled: false, scope: "off", budget: 100 }, collections: ["library:cell-a"] };

test("an override mentioning memory replaces it WHOLESALE (no deep merge with the cell)", () => {
  const res = effectiveProfile(CELL_STRICT, { memory: { budget: 800 } });
  assert.equal(res.ok, true);
  // unmentioned memory fields fall back to PLATFORM defaults, not the cell's
  // off/100 state — an override is a complete statement about what it mentions.
  assert.deepEqual(res.profile.memory, { enabled: true, scope: "own+shared", budget: 800 });
  // collections unmentioned → inherited from the cell default
  assert.deepEqual(res.profile.collections, ["library:cell-a"]);
});

test("an override mentioning collections replaces them WHOLESALE (no concat)", () => {
  const res = effectiveProfile(CELL_STRICT, { collections: ["library:dep-b", "library:dep-c"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.collections, ["library:dep-b", "library:dep-c"]);
  // memory unmentioned → inherited from the cell default
  assert.deepEqual(res.profile.memory, { enabled: false, scope: "off", budget: 100 });
});

test("keys the override never mentions inherit the base", () => {
  const res = effectiveProfile(CELL_STRICT, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile, { memory: { enabled: false, scope: "off", budget: 100 }, collections: ["library:cell-a"] });
});

test("a null/undefined override means the cell default stands", () => {
  assert.deepEqual(effectiveProfile(CELL_STRICT, null).profile, {
    memory: { enabled: false, scope: "off", budget: 100 },
    collections: ["library:cell-a"],
  });
  assert.deepEqual(effectiveProfile(null, undefined).profile, KNOWLEDGE_DEFAULTS);
});

test("an explicit null segment resets that segment to platform defaults", () => {
  const res = effectiveProfile(CELL_STRICT, { memory: null });
  assert.equal(res.ok, true);
  assert.deepEqual(res.profile.memory, { enabled: true, scope: "own+shared", budget: 1200 });
  assert.deepEqual(res.profile.collections, ["library:cell-a"]);
});

test("an invalid override reports ok:false with the normalize errors", () => {
  const res = effectiveProfile(CELL_STRICT, { memory: { budget: 99999 } });
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "memory_budget_invalid");
});

test("an invalid cell default reports ok:false too", () => {
  const res = effectiveProfile({ memory: { scope: "bogus" } }, {});
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, "memory_scope_invalid");
});

// ── knowledgeFindings: the blueprint-validate hook ──────────────────────────

test("absent or null knowledge is legal (no findings)", () => {
  assert.deepEqual(knowledgeFindings({ boundary: {} }), []);
  assert.deepEqual(knowledgeFindings({ knowledge: null }), []);
});

test("an invalid segment surfaces a finding with the knowledge. entry prefix", () => {
  const f = knowledgeFindings({ knowledge: { memory: { scope: "everything" } } });
  assert.equal(f.length, 1);
  assert.equal(f[0].entry, "knowledge.memory.scope");
  assert.equal(f[0].code, "memory_scope_invalid");
  assert.match(f[0].error, /own\+shared/);
});

test("collection errors carry their index in the entry", () => {
  const f = knowledgeFindings({ knowledge: { collections: ["library:ok", "nope"] } });
  assert.equal(f.length, 1);
  assert.equal(f[0].entry, "knowledge.collections[1]");
  assert.equal(f[0].code, "collection_ref_invalid");
});

test("knowledgeFindings threads resolveCollection like dataSourceFindings", () => {
  const f = knowledgeFindings({ knowledge: { collections: ["library:missing-1"] } }, (id) =>
    id === "missing-1" ? "no such collection in this deployment" : true,
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "collection_unresolved");
  assert.match(f[0].error, /library:missing-1/);
});

test("a non-object knowledge segment maps to the bare knowledge entry", () => {
  const f = knowledgeFindings({ knowledge: "off" });
  assert.equal(f.length, 1);
  assert.equal(f[0].entry, "knowledge");
  assert.equal(f[0].code, "profile_invalid");
});

test("validateBlueprint runs the knowledge segment in its chain", () => {
  const verdict = validateBlueprint({ knowledge: { memory: { budget: 99999 } } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.findings.knowledge.length >= 1, "knowledge bucket present in findings");
  assert.equal(verdict.findings.knowledge[0].code, "memory_budget_invalid");
  assert.equal(verdict.findings.knowledge[0].entry, "knowledge.memory.budget");
  assert.ok(verdict.errors.some((e) => e.code === "memory_budget_invalid"), "knowledge findings ride the flat errors list");
});
