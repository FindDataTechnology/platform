#!/usr/bin/env node
// ── Fleet binding health tests
//    (enable-constructor-skill-authoring / D8 ③ 观测面) ───────────────────────
//
// Pins the promotion of the install report's `awaiting-local-binding` line into
// a fleet-health projection. Motivation (2026-11-08 live): the optimizer team
// installed clean, `actions-mcp` never bound, and the fleet read green until a
// post's turn failed — the dead reference was visible only inside the install
// report.
//
//   node --test scripts/test-fleet-binding-health.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { bindingHealth, fleetBindingHealth, UNBOUND_STATUS } =
  await import(path.join(here, "../lib/fleet-binding-health.js"));

const installedWith = (...servers) => ({ report: { mcpServers: servers } });

test("an unbound reference degrades the fleet and is named", () => {
  const out = bindingHealth(installedWith(
    { name: "fleet-architect", status: "bound" },
    { name: "actions-mcp", status: UNBOUND_STATUS },
  ));
  assert.equal(out.ok, false);
  assert.equal(out.awaiting, true);
  assert.deepEqual(out.unbound, ["actions-mcp"]);
  assert.deepEqual(out.bound, ["fleet-architect"]);
});

test("all references bound is healthy", () => {
  const out = bindingHealth(installedWith({ name: "actions-mcp", status: "bound" }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.unbound, []);
});

test("a missing install record is not evidence of breakage", () => {
  for (const rec of [null, undefined, {}, { report: null }, { report: {} }]) {
    const out = bindingHealth(rec);
    assert.equal(out.ok, true, `record ${JSON.stringify(rec)} must read healthy`);
    assert.deepEqual(out.unbound, []);
  }
});

test("reused and installed statuses count as bound", () => {
  const out = bindingHealth(installedWith(
    { name: "wire-build-mcp", status: "reused" },
    { name: "facet-market", status: "installed" },
  ));
  assert.equal(out.ok, true);
  assert.deepEqual(out.bound.sort(), ["facet-market", "wire-build-mcp"]);
});

test("fleet projection carries the packId it bound against", () => {
  const fleet = { sourceTemplate: { packId: "gkHE4CsQHC2rEV0ZWziqWg" } };
  const out = fleetBindingHealth(fleet, installedWith({ name: "actions-mcp", status: UNBOUND_STATUS }));
  assert.equal(out.packId, "gkHE4CsQHC2rEV0ZWziqWg");
  assert.deepEqual(out.unbound, ["actions-mcp"]);
});

test("a hand-built fleet has nothing to bind and reads healthy", () => {
  const out = fleetBindingHealth({ sourceTemplate: null }, null);
  assert.equal(out.ok, true);
  assert.equal(out.packId, null);
});

test("malformed server entries are skipped, not thrown on", () => {
  const out = bindingHealth({ report: { mcpServers: [null, {}, { status: "bound" }, { name: "x" }] } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.bound, ["x"]);
});
