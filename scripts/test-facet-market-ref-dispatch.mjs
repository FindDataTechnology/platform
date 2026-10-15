// Unit tests — pack-store credential-ref dispatch (add-facet-market-credentials D4).
// Run: node --test scripts/test-facet-market-ref-dispatch.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolation env BEFORE importing anything that binds the db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "fm-ref-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const db = await import("../db.js");
await db.initDb();
const { credentialRefForEntry, credentialConnected } = await import("../pack-store.js");
const fm = await import("../facet-market-credentials.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const EMAIL = "dispatcher@test.example";

test("absent declaration defaults to the registry credential", () => {
  assert.equal(credentialRefForEntry({ credentialRef: null }), "registry");
  assert.equal(credentialRefForEntry({}), "registry");
  assert.equal(credentialRefForEntry(null), "registry");
});

test("a declaring entry carries its line's ref", () => {
  assert.equal(credentialRefForEntry({ credentialRef: "facet-market" }), "facet-market");
});

test("facet-market requires pairing (not registry connection)", () => {
  // unpaired: facet-market disconnected even though the check is ref-aware
  assert.equal(credentialConnected("facet-market", EMAIL), false);
});

test("paired facet-market counts as connected", async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    json: async () => ({
      ok: true,
      token: "h.c.s", // placeholder shape — pair only stores the cache
      email: "facet-user@test.example",
    }),
  });
  // Note: pair parses exp from the token's payload; a malformed one yields
  // null expiry, which still counts as connected (stale=false).
  const status = await fm.pair(EMAIL, "998877", { fetchImpl });
  assert.equal(status.connected, true);
  assert.equal(credentialConnected("facet-market", EMAIL), true);
  // registry credential remains a separate check (not connected here)
  assert.equal(credentialConnected("registry", EMAIL), false);
});
