// Thinking-level capability gate (fix-effort-is-per-model).
//
// The defect this pins was live: cell 2b043ce050ca134c's `standard` post failed
// every daily fire with
//   pi-ai provider "volces" model "cohere/north-mini-code:free"
//   does not support reasoning effort "high"
// because the level was persisted per PROVIDER (`llm.effort.volces`) and
// validated against the union of every model on the deployment — so a level
// picked for `deepseek-v4.1-flash` reached a model that declares none.
//
// These cases are the contract: a level belongs to the model that declares it.

import { test } from "node:test";
import assert from "node:assert/strict";

const { declaredLevels, effectiveEffort, effortWasDropped } = await import("../server/effort-gate.js");

const reasoning = { id: "deepseek-v4.1-flash", reasoningEfforts: { low: "low", medium: "medium", high: "high" } };
const nonReasoning = { id: "cohere/north-mini-code:free", reasoningEfforts: false };
const undeclared = { id: "some-model" }; // absent = inherits the catalog; no levels declared here

test("a level declared by the model is sent as-is", () => {
  assert.deepEqual(declaredLevels(reasoning), ["low", "medium", "high"]);
  assert.equal(effectiveEffort("high", reasoning), "high");
  assert.equal(effortWasDropped("high", reasoning), false);
});

test("a level the model does not declare is dropped, not sent", () => {
  assert.equal(effectiveEffort("high", nonReasoning), null);
  assert.equal(effortWasDropped("high", nonReasoning), true, "the drop must be nameable so it can be logged/persisted");
});

test("a model with no declaration at all never receives a level", () => {
  assert.deepEqual(declaredLevels(undeclared), []);
  assert.equal(effectiveEffort("high", undeclared), null);
});

test("clearing is always allowed and is not a drop", () => {
  for (const model of [reasoning, nonReasoning, undeclared, null, undefined]) {
    assert.equal(effectiveEffort(null, model), null);
    assert.equal(effectiveEffort("", model), null);
    assert.equal(effortWasDropped(null, model), false);
    assert.equal(effortWasDropped("", model), false);
  }
});

test("an unknown model is not a licence to send the level", () => {
  // The failure mode this closes: "unknown capability" used to read as "fine".
  assert.equal(effectiveEffort("high", null), null);
  assert.equal(effectiveEffort("high", { id: "x", reasoningEfforts: {} }), null);
});
