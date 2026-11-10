#!/usr/bin/env node
// ── Connector bindings declaration validation (add-connector-bindings, 1.1-1.3) ─
//
// A pack's `connector_bindings` is the machine-readable promise "this pack needs
// these external systems, at (provider, operationType) grain". Publish and
// install both run validatePackManifest, so these level tests pin the contract
// without a live facet.
//
// The two fixtures are the real 仓配分销 connector pack: `-before` is the shape
// that shipped (prose `provider_status`, no machine fields) and `-after` is the
// same pack with the machine fields filled in. Keeping both as cases means the
// validator cannot quietly start accepting prose, nor start rejecting a legal
// declaration.
//
//   node --test scripts/test-connector-bindings-manifest.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";

const BASE = {
  name: "T",
  skills: [{ name: "s", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

const withBindings = (bindings) => ({ ...BASE, connector_bindings: bindings });
const errorsFor = (bindings) => validatePackManifest(withBindings(bindings));
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/connector-bindings/${name}`, import.meta.url), "utf8"));

const legal = {
  key: "kingdee-cloud",
  provider: "kingdee",
  allowOperations: [{ operationType: "read" }, { operationType: "write" }],
  connectionHint: "金蝶云星空账套",
  optional: false,
  external_system: "金蝶云星空",
  note: "human prose",
};

test("a legal declaration validates clean", () => {
  assert.deepEqual(errorsFor([legal]), []);
});

test("operation classes may be shorthands for the binding's own provider", () => {
  assert.deepEqual(errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["read"] }]), []);
});

test("allowActions alone is a legal scope", () => {
  assert.deepEqual(errorsFor([{ key: "k", provider: "kingdee", allowActions: ["kingdee.list_bills"] }]), []);
});

test("a binding with only human fields is rejected for missing scope, not missing description", () => {
  const errors = errorsFor([
    {
      key: "prose-only",
      external_system: "金蝶云星空",
      surface: "凭证/往来推送",
      direction: "push-via-connector",
      credential: "BYOK：ERP_BYOK_KINGDEE_*",
      note: "对外付款 = 核对指令输出",
    },
  ]);
  // No provider either — the binding is prose, so that is reported too. What
  // matters is that the *scope* gap is named and prose is never asked for.
  const scope = errors.find((e) => e.code === "connector_binding_scope_missing");
  assert.ok(scope, `expected a scope error, got ${JSON.stringify(errors)}`);
  assert.match(scope.error, /declares no scope/);
  assert.ok(errors.every((e) => !/description/.test(e.error)));
});

test("a duplicate key is rejected and names the conflicting key", () => {
  const errors = errorsFor([legal, { key: "kingdee-cloud", provider: "kingdee", allowOperations: ["read"] }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[1].key");
  assert.match(errors[0].error, /duplicate connector binding key 'kingdee-cloud'/);
});

test("an empty key or provider is rejected per field", () => {
  const errors = errorsFor([{ key: " ", provider: "", allowOperations: ["read"] }]);
  const entries = errors.map((e) => e.entry);
  assert.deepEqual(entries.sort(), ["connector_bindings[0].key", "connector_bindings[0].provider"]);
});

test("an operation class outside the closed set is rejected", () => {
  // `destructive` is a real catalog class but is not grantable by a binding.
  const errors = errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["destructive"] }]);
  const classError = errors.find((e) => e.entry === "connector_bindings[0].allowOperations[0]");
  assert.ok(classError, `expected a class error, got ${JSON.stringify(errors)}`);
  assert.match(classError.error, /read\/write/);
});

test("an operation scope for an undeclared provider is rejected", () => {
  const errors = errorsFor([
    { key: "k", provider: "kingdee", allowOperations: [{ provider: "feishu", operationType: "read" }] },
  ]);
  const providerError = errors.find((e) => /not this binding's provider/.test(e.error));
  assert.ok(providerError, `expected a provider error, got ${JSON.stringify(errors)}`);
  assert.equal(providerError.entry, "connector_bindings[0].allowOperations[0]");
});

test("an operation scope for an alternative provider is accepted", () => {
  assert.deepEqual(
    errorsFor([
      {
        key: "k",
        provider: "wechatpay",
        alternativeProviders: ["alipay"],
        allowOperations: [{ provider: "alipay", operationType: "read" }],
      },
    ]),
    [],
  );
});

test("optional must be a boolean when present", () => {
  const errors = errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["read"], optional: "yes" }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[0].optional");
});

test("the later ledger-owned status field is not writable prose", () => {
  const errors = errorsFor([{ ...legal, provider_status: "directory-provider" }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /decided by the binding ledger/);
});

test("a single provider may carry two bindings with different ranges", () => {
  assert.deepEqual(
    errorsFor([
      { key: "kingdee-read", provider: "kingdee", allowOperations: ["read"] },
      { key: "kingdee-write", provider: "kingdee", allowOperations: ["write"] },
    ]),
    [],
  );
});

test("the real pack is rejected before the machine fields land", () => {
  const errors = validatePackManifest(fixture("supply-chain-before.json"));
  // Every binding fails on the same two facts: prose status is not writable, and
  // there is no scope to grant. Nothing else in the manifest is wrong.
  const codes = errors.map((e) => e.code);
  assert.equal(codes.filter((code) => code === "connector_binding_scope_missing").length, 5);
  assert.equal(codes.filter((code) => code.includes("provider_status")).length, 0);
  assert.ok(
    errors.every((e) => e.entry.startsWith("connector_bindings")),
    `unexpected non-binding errors: ${JSON.stringify(errors.filter((e) => !e.entry?.startsWith("connector_bindings")))}`,
  );
});

test("the real pack passes once the machine fields are filled in", () => {
  assert.deepEqual(validatePackManifest(fixture("supply-chain-after.json")), []);
});

test("the real pack's after-state keeps the human fields untouched", () => {
  const manifest = fixture("supply-chain-after.json");
  for (const binding of manifest.connector_bindings) {
    for (const field of ["external_system", "surface", "direction", "credential", "note"]) {
      assert.equal(typeof binding[field], "string", `${binding.key} lost ${field}`);
    }
  }
});

// ── role vocabulary (2026-11-08) ────────────────────────────────────────────
//
// A role name is the lookup key in connector_role_mappings(email, role): two
// packs declaring the same need must spell it identically or the customer
// answers twice. The shape rule therefore lives HERE (where every pack is
// validated), not only in the template repo that happens to publish today.

test("a role name must be kebab-case", () => {
  // "pos system" also trips the older no-spaces rule, so the assertion is that
  // the kebab-case error is among the reported ones — not that it is the only one.
  for (const bad of ["PosSystem", "pos_system", "pos system", "POS"]) {
    const errors = errorsFor([{ key: "p", provider: bad, providerRole: true, allowOperations: ["read"] }]);
    const shape = errors.filter((e) => /kebab-case role name/.test(e.error));
    assert.equal(shape.length, 1, `${bad} must be rejected by the shape rule`);
    assert.equal(shape[0].entry, "connector_bindings[0].provider");
  }
  for (const good of ["pos", "cn-commerce", "supplier-portal2"]) {
    assert.deepEqual(
      errorsFor([{ key: "p", provider: good, providerRole: true, allowOperations: ["read"] }]),
      [],
      `${good} must be accepted`,
    );
  }
});

test("a role binding may not carry alternativeProviders", () => {
  const errors = errorsFor([
    {
      key: "p",
      provider: "pos",
      providerRole: true,
      allowOperations: ["read"],
      alternativeProviders: ["wangdian"],
    },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[0].alternativeProviders");
  assert.match(errors[0].error, /must not accompany providerRole/);
});

test("the shape rule does not touch plain provider ids", () => {
  // CamelCase / snake_case are fine for real service ids — only the ROLE form is
  // constrained, so this rule can never reject a pack that talks to a vendor.
  assert.deepEqual(
    errorsFor([
      { key: "a", provider: "kingdee", allowOperations: ["read"] },
      { key: "b", provider: "sf_express", allowOperations: ["read"] },
      { key: "c", provider: "wechatpay", allowOperations: ["read"], alternativeProviders: ["alipay"] },
    ]),
    [],
  );
});

// ── providerRole (add-connector-role-mapping 1.1) ───────────────────────────

test("a role binding validates clean and keeps provider as the role name", () => {
  const roleBinding = {
    key: "wms-snapshot",
    provider: "wms",
    providerRole: true,
    allowOperations: ["read"],
    optional: true,
  };
  assert.deepEqual(errorsFor([roleBinding]), []);
});

test("providerRole must be a boolean when present", () => {
  const errors = errorsFor([
    { key: "wms-snapshot", provider: "wms", providerRole: "true", allowOperations: ["read"] },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[0].providerRole");
  assert.match(errors[0].error, /must be a boolean/);
});

test("a non-boolean role flag is reported per binding, not once per pack", () => {
  const errors = errorsFor([
    { key: "a", provider: "wms", providerRole: "yes", allowOperations: ["read"] },
    { key: "b", provider: "carrier", providerRole: 1, allowOperations: ["read"] },
  ]);
  assert.deepEqual(
    errors.map((e) => e.entry),
    ["connector_bindings[0].providerRole", "connector_bindings[1].providerRole"],
  );
});

test("a role binding still needs a scope (providerRole is not a scope)", () => {
  const errors = errorsFor([{ key: "wms-snapshot", provider: "wms", providerRole: true }]);
  assert.equal(errors[0].code, "connector_binding_scope_missing");
});

test("providerRole: false is a normal service-id binding, not a role", () => {
  const errors = errorsFor([
    { key: "kingdee-cloud", provider: "kingdee", providerRole: false, allowOperations: ["read"] },
  ]);
  assert.deepEqual(errors, []);
});
