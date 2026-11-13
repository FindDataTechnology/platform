// Unit tests — plugin contribution classes (change harden-plugin-supply-gates,
// tasks 2.1 / 4.1 / 4.2).
// Run: node --test scripts/test-plugin-contribution-class.mjs
//
// The load-bearing case is that `tool` is REFUSED. That is not caution for its
// own sake: the platform's tool gate is keyed by MCP server name
// (`capByOperatorFace(..., Object.keys(servers))` from mcp.json) and plugin-native
// tools carry no server key, so a tool-contributing bundle would sit outside
// every gate the platform has. A future reader must argue with that reason —
// not just delete a string from a list.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_CONTRIBUTIONS,
  FORBIDDEN_CONTRIBUTIONS,
  validateContributionDeclaration,
  validateSupplyManifest,
  allowedClassesOf,
} from "../lib/plugin-contribution-spec.js";

test("the three reviewable classes are accepted", () => {
  for (const cls of ALLOWED_CONTRIBUTIONS) {
    assert.deepEqual(validateContributionDeclaration({ name: "@acme/thing", contributes: [cls] }), []);
  }
});

test("a tool-contributing bundle is refused by name", () => {
  const errors = validateContributionDeclaration({ name: "@acme/toolkit", contributes: ["tool"] });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /'tool' is not allowed/);
  assert.match(errors[0].error, /no MCP server key/);
  assert.equal(errors[0].entry, "supply entry.contributes");
});

test("the four forbidden classes each carry their own reason", () => {
  for (const cls of Object.keys(FORBIDDEN_CONTRIBUTIONS)) {
    const errors = validateContributionDeclaration({ name: "@acme/x", contributes: [cls] });
    assert.equal(errors.length, 1, `${cls} must be refused`);
    assert.ok(errors[0].error.includes(FORBIDDEN_CONTRIBUTIONS[cls]), `${cls} must state its reason`);
  }
  assert.deepEqual(Object.keys(FORBIDDEN_CONTRIBUTIONS).sort(), ["channel", "credential", "llm", "tool"]);
});

test("an undeclared bundle is refused, never assumed harmless", () => {
  const errors = validateContributionDeclaration({ name: "@acme/opaque" });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /contributes must be a non-empty array/);
});

test("a mixed declaration keeps the allowed classes and refuses the rest", () => {
  const errors = validateContributionDeclaration({ name: "@acme/mixed", contributes: ["skill", "tool", "ui"] });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /'tool' is not allowed/);
  // The permitted part still reports honestly for the roster reader.
  assert.deepEqual(allowedClassesOf({ contributes: ["skill", "tool", "ui"] }), ["skill", "ui"]);
});

test("unknown class names are refused with the allowed set named", () => {
  const errors = validateContributionDeclaration({ name: "@acme/x", contributes: ["telepathy"] });
  assert.match(errors[0].error, /unknown contribution class 'telepathy'/);
  assert.match(errors[0].error, /skill, ui, service/);
});

test("duplicates and the class ceiling are refused", () => {
  assert.match(
    validateContributionDeclaration({ name: "@acme/x", contributes: ["ui", "ui"] })[0].error,
    /declared twice/,
  );
  const tooMany = validateContributionDeclaration({ name: "@acme/x", contributes: ["ui", "ui", "ui", "ui", "ui"] });
  assert.ok(tooMany.some((e) => /at most 4/.test(e.error)));
});

test("a supply manifest validates entry by entry and duplicates bundles", () => {
  const errors = validateSupplyManifest({
    bundles: [
      { name: "@acme/a", contributes: ["skill"] },
      { name: "@acme/a", contributes: ["ui"] },
      { name: "@acme/b", contributes: ["tool"] },
    ],
  });
  assert.ok(errors.some((e) => /'@acme\/a' is listed twice/.test(e.error)));
  assert.ok(errors.some((e) => /'tool' is not allowed/.test(e.error)));
});

test("an absent or empty supply manifest is honest empty, not an error", () => {
  assert.deepEqual(validateSupplyManifest(undefined), []);
  assert.deepEqual(validateSupplyManifest({}), []);
  assert.deepEqual(validateSupplyManifest({ bundles: [] }), []);
});
