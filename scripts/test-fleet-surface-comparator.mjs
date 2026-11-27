#!/usr/bin/env node
// ── The comparator must be able to say NO ───────────────────────────────────
//
// scripts/lib/fleet-surface-compare.mjs shipped TWO silent defects in this
// change's first draft, and the comparator's failure mode is the dangerous
// one: it reported "identical" for trees that differed. A regression here
// would make the fleet split pass review while breaking the API.
//
// Both are pinned by feeding the functions objects KNOWN to differ — the only
// check that can catch an always-green comparator.
//
// Run: node --test scripts/test-fleet-surface-comparator.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { canonical, diff, compareSurfaces, TIME_KEYS } from "./lib/fleet-surface-compare.mjs";

test("diff detects a changed leaf (the first draft returned [] here)", () => {
  assert.deepEqual(diff({ a: 1 }, { a: 2 }, "x"), ["x.a: 1 -> 2"]);
});

test("diff detects a changed leaf NESTED inside objects and arrays", () => {
  const a = { members: [{ id: "m1", title: "甲" }] };
  const b = { members: [{ id: "m1", title: "乙" }] };
  assert.deepEqual(diff(a, b, "x"), ['x.members[0].title: "甲" -> "乙"']);
});

test("diff reports added / removed keys and length changes", () => {
  assert.deepEqual(diff({ a: 1 }, { a: 1, b: 2 }, "x"), ["x.b: added"]);
  assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1 }, "x"), ["x.b: removed"]);
  assert.deepEqual(diff({ l: [1, 2] }, { l: [1] }, "x"), ["x.l: length 2 -> 1"]);
});

test("diff reports type changes rather than crashing on them", () => {
  assert.deepEqual(diff({ a: 1 }, { a: "1" }, "x"), ["x.a: type number -> string"]);
  assert.deepEqual(diff({ a: null }, { a: {} }, "x"), ["x.a: type null -> object"]);
});

test("diff says nothing for equal values (the negative control)", () => {
  assert.deepEqual(diff({ a: [1, 2] }, { a: [1, 2] }, "x"), []);
  assert.deepEqual(diff("same", "same", "x"), []);
});

test("canonical masks timestamps so two fresh runs compare equal", () => {
  for (const k of TIME_KEYS) {
    const a = canonical({ [k]: 1795467587269 });
    const b = canonical({ [k]: 1795467595236 });
    assert.deepEqual(a, b, `${k} must be masked`);
    assert.equal(a[k], "<ts>");
  }
});

test("canonical sorts id-carrying arrays so creation order is not a difference", () => {
  const a = canonical({ fleets: [{ id: "b", n: 2 }, { id: "a", n: 1 }] });
  const b = canonical({ fleets: [{ id: "a", n: 1 }, { id: "b", n: 2 }] });
  assert.deepEqual(a, b);
});

test("canonical does NOT hide a behavioural difference behind the sorting", () => {
  const a = canonical({ fleets: [{ id: "a", n: 1 }] });
  const b = canonical({ fleets: [{ id: "a", n: 9 }] });
  assert.deepEqual(diff(a, b, "x"), ["x.fleets[0].n: 1 -> 9"]);
});

test("canonical leaves non-id arrays in order (order is meaningful there)", () => {
  const a = canonical({ tags: ["x", "y"] });
  const b = canonical({ tags: ["y", "x"] });
  assert.notDeepEqual(a, b, "an ordinary array's order is data, not jitter");
});

test("compareSurfaces reports disappeared and added endpoints", () => {
  assert.deepEqual(compareSurfaces({ "GET /a": {} }, {}), ["GET /a: endpoint disappeared"]);
  assert.deepEqual(compareSurfaces({}, { "GET /a": {} }), ["GET /a: endpoint added"]);
});

test("compareSurfaces on identical surfaces is silent", () => {
  const s = { "GET /f": { body: { fleets: [{ id: "a", n: 1, createdAt: "<ts>" }] } } };
  assert.deepEqual(compareSurfaces(s, structuredClone(s)), []);
});
