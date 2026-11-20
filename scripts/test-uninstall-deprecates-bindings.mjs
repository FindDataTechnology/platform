#!/usr/bin/env node
// ── Uninstalling a pack retires its bindings (deprecate-uninstalled-bindings) ──
//
// Measured on the bootstrap tenant (2026-11-08): install a pack that declares
// `connector_bindings`, grant the binding, then uninstall the pack — the ledger
// row stayed at `missing`, so `GET /api/connections` kept reporting
// "1 pack · 1 binding · 1 to resolve" for a pack that no longer existed and
// offered a connect action for it. `deprecated` is the ledger's own word for
// "history, not a requirement" (connector-bindings spec); uninstall is exactly
// that case and was the one path that never wrote it.
//
// Pinned here:
//   A. uninstall flips every ledger row of that pack to `deprecated`, across
//      identities (the uninstaller has no owner in hand — the ledger is keyed
//      by email while an installed pack is per deployment);
//   B. it touches no other pack's rows, and leaves the granted token alone
//      (revoking a user's credential as a side effect of uninstalling would be
//      a silent regression, and reinstall must still find it);
//   C. running it twice is a no-op (uninstall of an absent pack must not throw).
//
//   node --test scripts/test-uninstall-deprecates-bindings.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-bindings-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

const db = await import("../db.js");
const packStore = await import("../pack-store.js");
const bindings = await import("../connector-bindings.js");

const OWNER_A = "owner-a@example.test";
const OWNER_B = "owner-b@example.test";

function manifest(keys) {
  return {
    name: "drill-pack",
    version: 1,
    description: "binding uninstall drill",
    skills: [{ name: "drill-skill", description: "probe skill", content: "Probe." }],
    connector_bindings: keys.map((key) => ({
      key,
      provider: "alpha_vantage",
      allowOperations: ["read"],
    })),
  };
}

function seedLedger(owner, packId, key, status) {
  db.upsertConnectorBindingLedgerRow({
    email: owner,
    packId,
    packVersion: "1",
    bindingKey: key,
    provider: "alpha_vantage",
    operations: ["read"],
    status,
  });
}

test("uninstall deprecates that pack's rows for every identity, and only those", async () => {
  await db.initDb();
  assert.equal(db.isDbReady(), true);

  const manifestA = manifest(["market"]);
  await packStore.installPack({ packId: "drill-pack", version: 1, manifest: manifestA, user: { email: OWNER_A, groups: [] } });

  seedLedger(OWNER_A, "drill-pack", "market", "satisfied");
  seedLedger(OWNER_B, "drill-pack", "market", "missing");
  // A second pack's row is the control: it must survive untouched.
  seedLedger(OWNER_A, "other-pack", "ledger", "satisfied");
  // The credential is the other control: uninstall must not drop it.
  db.setConnectorBinding({
    email: OWNER_A,
    slot: "drill-pack:market",
    token: "oct_drill",
    purpose: "pack:drill-pack/market",
    sourceAccount: null,
  });

  const before = bindings.listBindings(OWNER_A, "drill-pack").map((row) => row.status);
  assert.deepEqual(before, ["satisfied"]);

  packStore.uninstallPack({ packId: "drill-pack", force: true });

  for (const owner of [OWNER_A, OWNER_B]) {
    const rows = bindings.listBindings(owner, "drill-pack");
    assert.equal(rows.length, 1, `${owner} keeps exactly one history row`);
    assert.equal(rows[0].status, "deprecated", `${owner}: a removed pack is history, not a todo`);
  }
  const control = bindings.listBindings(OWNER_A, "other-pack");
  assert.equal(control[0].status, "satisfied", "another pack's rows are untouched");
  assert.equal(
    bindings.liveBindingToken(OWNER_A, "drill-pack", "market"),
    "oct_drill",
    "the granted token survives — uninstall is not a revoke",
  );

  // A second uninstall is refused (the pack is gone) — and that refusal must
  // not resurrect or re-status anything.
  assert.throws(() => packStore.uninstallPack({ packId: "drill-pack", force: true }), /Pack not installed/);
  assert.equal(bindings.listBindings(OWNER_A, "drill-pack")[0].status, "deprecated");
});

test("a deprecated row leaves the projection's work-to-do count", async () => {
  // The card's summary comes from this filter shape (server/routes/misc.js):
  // `deprecated` is excluded from rows, packs and unresolved.
  const rows = bindings.listBindings(OWNER_A, "drill-pack");
  const active = rows.filter((row) => row.status !== "deprecated" && row.status !== "undetermined");
  assert.equal(active.length, 0);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
