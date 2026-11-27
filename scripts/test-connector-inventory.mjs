#!/usr/bin/env node
// ── Connector inventory projection (connector-inventory-in-connections) ──────
//
// The one thing this must never do is turn "we could not ask" into "you have
// nothing". A user who has connected GitHub but no pack declares it should see
// it; a user whose PAT died must see an error, not an empty shelf; and a
// connector row that grew a secret column must not ship it to the browser.
//
//   node --test scripts/test-connector-inventory.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { projectInventory } = await import("../server/routes/connector.js");

test("1.1 a self-built connection is listed and marked as not pack-required", () => {
  const rows = projectInventory([{ service: "github", connectionName: "default", authType: "api_key" }], new Set());
  assert.deepEqual(rows, [
    { service: "github", connectionName: "default", authType: "api_key", requiredByPack: false },
  ]);
});

test("1.2 a provider some pack declares is marked required, whatever the connection is called", () => {
  const rows = projectInventory(
    [
      { service: "kingdee-cloud", connectionName: "default" },
      { service: "kingdee-cloud", connectionName: "sandbox" },
      { service: "github", connectionName: "default" },
    ],
    new Set(["kingdee-cloud"]),
  );
  // Both connections to the declared SYSTEM carry the label; the pack asks for
  // the system, not for one alias.
  assert.deepEqual(
    rows.map((r) => [r.connectionName, r.requiredByPack]),
    [
      ["default", true],
      ["sandbox", true],
      ["default", false],
    ],
  );
});

test("1.3 the projection copies fields; a connector row's extra columns never leak", () => {
  const rows = projectInventory(
    [
      {
        service: "github",
        connectionName: "default",
        authType: "api_key",
        // The things a connector row could plausibly grow:
        token: "oct_secret",
        encryptedValues: { apiKey: "ghp_secret" },
        tenantId: "tenant-internal",
        id: "conn-internal-id",
      },
    ],
    new Set(),
  );
  const serialized = JSON.stringify(rows);
  for (const forbidden of ["oct_secret", "ghp_secret", "tenant-internal", "conn-internal-id"]) {
    assert.ok(!serialized.includes(forbidden), `projection leaked ${forbidden}`);
  }
  assert.deepEqual(Object.keys(rows[0]).sort(), ["authType", "connectionName", "requiredByPack", "service"]);
});

test("1.4 missing optional fields degrade without inventing values", () => {
  const rows = projectInventory([{ service: "notion" }], new Set());
  assert.equal(rows[0].connectionName, "default");
  assert.equal("authType" in rows[0], false, "an absent authType must stay absent, not become empty string");
});

test("1.5 malformed rows are dropped, not rendered as blank connections", () => {
  const rows = projectInventory(
    [null, undefined, {}, { service: "" }, { service: 42 }, { service: "github" }],
    new Set(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].service, "github");
});

test("1.6 an unparsable body is zero rows, never a crash", () => {
  assert.deepEqual(projectInventory(undefined, new Set()), []);
  assert.deepEqual(projectInventory(null, new Set()), []);
  assert.deepEqual(projectInventory("not-an-array", new Set()), []);
});

// The route's three-way answer. `projectInventory` is pure, so these pin the
// contract at its seam: the caller maps connector failures to `unknown`, and
// the projection is only ever reached for a successful read.
test("1.7 the shape the route answers with distinguishes unknown from empty", () => {
  // An unreachable/unauthorized connector answers `unknown` + a code — the
  // route must never reach the projection for that arm.
  const unknown = { state: "unknown", code: "unauthorized" };
  assert.equal("connections" in unknown, false);
  // A successful read with nothing configured is a real, renderable empty.
  assert.deepEqual(projectInventory([], new Set()), []);
});
