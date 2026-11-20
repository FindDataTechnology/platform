// Contract tests for fix-effort-is-per-model-not-per-provider.
//
// Live failure this pins (cell 2b043ce050ca134c, 2026-11-10/11/13): the
// `standard` post died every daily fire with
//   pi-ai provider "volces" model "cohere/north-mini-code:free"
//   does not support reasoning effort "high"
// because the level was persisted per PROVIDER and projected into the profile as
// `providers.volces.reasoning` — a route default pi-ai applies to every model of
// that route, including ones declared `reasoningEfforts: false`.
//
// Two properties are asserted here, both at the seam that used to leak:
//   1. the profile generator never emits a route-level `reasoning`;
//   2. the bridge drops a level the target model does not declare (and turns
//      the drop into an explicit clear, never "inherit").

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "effort-permodel-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.LLM_API_KEY = "test-key-not-used"; // the generator only needs a key to declare a route

const yaml = (await import("js-yaml")).default;
const profile = await import("../dsh-profile.js");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test("the generated profile carries NO route-level reasoning", async () => {
  const { providers } = await profile.buildLlmProfile();
  const volces = providers.volces;
  assert.ok(volces, "the volces route must be declared for this test to mean anything");
  // The exact field that broke production. A level here applies to every model
  // on the route at request-assembly time, before any capability check.
  assert.equal(
    Object.hasOwn(volces, "reasoning"),
    false,
    "providers.<route>.reasoning must not exist — a per-model capability cannot ride a per-route default",
  );
  // Per-model declarations stay: this is where the capability belongs.
  const ds = volces.models.find((m) => String(m.id).startsWith("deepseek-v4"));
  assert.ok(ds && Object.keys(ds.reasoningEfforts || {}).includes("high"), "reasoning models still declare their levels");
  const glm = volces.models.find((m) => String(m.id).startsWith("glm"));
  if (glm) assert.equal(glm.reasoningEfforts, false, "non-reasoning models still declare `false`");
});

test("the YAML written for dsh can never contain a route-level reasoning line", async () => {
  const { providers } = await profile.buildLlmProfile();
  const text = yaml.dump({ "llm-pi-ai": { providers } });
  assert.doesNotMatch(text, /^\s+reasoning:\s/m, "no `reasoning:` key may appear anywhere in the provider block");
});

test("the bridge gate drops an undeclared level and clears instead of inheriting", async () => {
  const { gateEffort } = await import("../dsh-bridge.js");
  const declaresNothing = () => [];

  // The production failure, at the seam: level `high` for a model that declares
  // none. The gate must return a CLEAR (null), never the level.
  const dropped = gateEffort({
    level: "high",
    model: "cohere/north-mini-code:free",
    provider: "volces",
    declaredEffortsFor: declaresNothing,
  });
  assert.equal(dropped.level, null, "an undeclared level must never leave the process");
  assert.equal(dropped.dropped, true, "the drop must be nameable so the caller can self-heal the preference");

  // A model that declares it keeps it.
  const kept = gateEffort({
    level: "high",
    model: "deepseek-v4.1-flash",
    provider: "volces",
    declaredEffortsFor: () => ["low", "medium", "high"],
  });
  assert.equal(kept.level, "high");
  assert.equal(kept.dropped, false);

  // "keep as-is" and "clear" keep their distinct meanings.
  assert.equal(gateEffort({ level: undefined, model: "m" }).level, undefined);
  assert.equal(gateEffort({ level: null, model: "m" }).level, null);
  assert.equal(gateEffort({ level: "", model: "m" }).level, null);

  // Unknown capability is not permission.
  assert.equal(gateEffort({ level: "high", model: "m", declaredEffortsFor: null }).level, null);
});

test("every level leaving the bridge goes through that gate", async () => {
  const src = fs.readFileSync(new URL("../dsh-bridge.js", import.meta.url), "utf8");
  // The three dispatch points: constructor(initialize), setModel, restart.
  assert.equal((src.match(/#gateEffort\(/g) || []).length >= 3, true, "constructor, setModel and restart must all gate");
  // Every assignment to the baked level must go through the gate — the raw
  // `this.#effort = effort || null` is how an ungated level reached initialize.
  const assigns = src.match(/this\.#effort\s*=\s*[^;\n]+/g) || [];
  const rawAssign = assigns.filter((line) => !line.includes("this.#gateEffort("));
  assert.equal(rawAssign.length, 0, "a raw level assignment would bypass the gate");
});

// ── Persistence addressing ──────────────────────────────────────────────────
// The level used to be stored per PROVIDER, which is how one model's choice
// became every model's default. These pin the per-model key, its one-shot
// migration from the old key, and self-healing of a value the model no longer
// declares.

function prefs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (k) => store.get(k),
    set: (k, v) => { if (v === "" || v === null) store.delete(k); else store.set(k, v); },
  };
}

test("a level is read and written per model, and models do not share it", async () => {
  const { modelEffortKey, resolvePersistedEffort } = await import("../server/effort-gate.js");
  assert.equal(modelEffortKey("volces", "deepseek-v4.1-flash"), "llm.effort.volces.deepseek-v4.1-flash");

  const p = prefs({ "llm.effort.volces.deepseek-v4.1-flash": "high" });
  const declared = ["low", "medium", "high"];
  const a = resolvePersistedEffort({ provider: "volces", model: "deepseek-v4.1-flash", declaredEfforts: declared, ...p });
  assert.equal(a.level, "high", "the model's own row is honoured");
  assert.equal(a.migrated, false);

  // The OTHER model on the same route reads its own (empty) row — nothing is
  // inherited from a sibling, which is what the provider-wide key did.
  const b = resolvePersistedEffort({ provider: "volces", model: "glm-5.3-flash", declaredEfforts: [], ...p });
  assert.equal(b.level, null, "a non-reasoning model must not inherit a sibling's level");
  assert.equal(p.store.get("llm.effort.volces.deepseek-v4.1-flash"), "high", "sibling read must not touch the other row");
});

test("the legacy provider key is migrated once, then cleared", async () => {
  const { resolvePersistedEffort } = await import("../server/effort-gate.js");
  const p = prefs({ "llm.effort.volces": "high" });
  const declared = ["low", "medium", "high"];

  const first = resolvePersistedEffort({ provider: "volces", model: "deepseek-v4.1-flash", declaredEfforts: declared, ...p });
  assert.equal(first.level, "high", "the operator's existing choice survives the upgrade");
  assert.equal(first.migrated, true, "the migration must be nameable");
  assert.equal(p.store.get("llm.effort.volces.deepseek-v4.1-flash"), "high", "it lands on the per-model key");
  assert.equal(p.store.has("llm.effort.volces"), false, "the provider-wide row is cleared, not kept as a second source");

  // Second boot: read from the new key, no second migration.
  const second = resolvePersistedEffort({ provider: "volces", model: "deepseek-v4.1-flash", declaredEfforts: declared, ...p });
  assert.equal(second.level, "high");
  assert.equal(second.migrated, false);
});

test("a legacy value the model does not declare is cleared instead of re-dropped", async () => {
  const { resolvePersistedEffort } = await import("../server/effort-gate.js");
  const p = prefs({ "llm.effort.volces": "high" });
  // The landing model declares nothing (the production shape: glm/cohere).
  const r = resolvePersistedEffort({ provider: "volces", model: "cohere/north-mini-code:free", declaredEfforts: [], ...p });
  assert.equal(r.level, null, "an undeclared legacy level must never be dispatched");
  assert.equal(p.store.has("llm.effort.volces"), false, "it is cleared so the next turn does not re-drop it");
  assert.equal(p.store.has("llm.effort.volces.cohere/north-mini-code:free"), false, "nothing is migrated into an unusable row");
});

test("a stored level the catalog stopped declaring self-heals", async () => {
  const { resolvePersistedEffort } = await import("../server/effort-gate.js");
  const p = prefs({ "llm.effort.volces.m1": "high" });
  const r = resolvePersistedEffort({ provider: "volces", model: "m1", declaredEfforts: ["low"], ...p });
  assert.equal(r.level, null);
  assert.deepEqual(r.cleared, ["llm.effort.volces.m1"], "the stale row is the thing that gets cleared");
  assert.equal(p.store.has("llm.effort.volces.m1"), false);
});

test("no writer still addresses a level by provider alone", async () => {
  // The two exact shapes that made the level provider-wide. Only the gate's own
  // legacy-key helper may name them.
  // Literal samples of the banned shape — built by concatenation so this file
  // does not itself trip noTemplateCurlyInString while still naming the string.
  // The banned shape is a template literal whose name comes from a variable.
  // Built by concatenation so THIS file does not itself contain the pattern it
  // forbids (biome's noTemplateCurlyInString would fire on the sample).
  const D = "$";
  const BT = String.fromCharCode(96);
  const forbidden = [BT + "llm.effort." + D + "{provider}" + BT, BT + "llm.effort." + D + "{target.provider}" + BT];
  for (const f of ["../server/agent-session.js", "../server.js", "../dsh-profile.js"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    for (const shape of forbidden) {
      assert.equal(src.includes(shape), false, `${f} still addresses a thinking level by provider alone (${shape})`);
    }
  }
});

