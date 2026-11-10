#!/usr/bin/env node
// ── Connector binding migration equivalence (add-connector-bindings 7.1/7.2) ──
//
// 2.1/2.3 prove the storage migration column by column. This file proves the
// thing a user notices: after upgrading, the connector capability a running
// agent already had is still there, unchanged, and nothing was granted that the
// user did not have.
//
//   7.1  A single-account install that could use the connector before the
//        upgrade can still use it after: the profile still carries a connector
//        row, and it authorizes with the SAME token. ("Same action still runs"
//        is exactly "same Authorization header still reaches the connector".)
//   7.2  Multi-account stock: the active account stays the primary, the other
//        accounts stay as sources, and the ledger is empty — the upgrade grants
//        no pack binding and revives no stale account.
//
//   node --test scripts/test-connector-binding-migration.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-migrate-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({
    mcpServers: {
      "file-server": { url: "https://file.example/mcp" },
      // The pre-change baseline: ONE global connector row with the account ref.
      connector: { url: "https://connector.example.test/mcp", credentialRef: "connector" },
    },
  }),
);
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const credentialRefs = await import("../credential-refs.js");
const { writeMcpPatch } = await import("../dsh-profile.js");

const bridge = await import("../registry-bridge.js");
bridge.initRegistryBridge({
  broadcast: () => {},
  fetchImpl: async (url) =>
    url.includes("/api/skills")
      ? { ok: true, status: 200, json: async () => ({ skills: [] }) }
      : url.includes("/api/agents")
        ? { ok: true, status: 200, json: async () => ({ agents: [] }) }
        : { ok: true, status: 200, json: async () => ({ servers: [] }) },
});
await bridge.refreshRegistry();
await db.initDb();

const PATCH_FILE = path.join(
  process.env.DSH_HOME,
  "profiles",
  process.env.DSH_PROFILE || "platform",
  "mcp.patch.yml",
);
async function writePatch(opts) {
  fs.rmSync(PATCH_FILE, { force: true });
  await writeMcpPatch(opts);
  return fs.readFileSync(PATCH_FILE, "utf8");
}
function patchEntries(text = fs.readFileSync(PATCH_FILE, "utf8")) {
  const rows = yaml.load(text);
  return Array.isArray(rows) ? (rows[0]?.insert ?? []) : [];
}
const patchEntry = (name, text) => patchEntries(text).find((entry) => entry.config.serverName === name);

// The rows a pre-114 install shipped: one active account per identity, plus a
// stale second account on the multi-account identity.
const PRIMARY_TOKEN = "oct_primary_live";
const SECONDARY_TOKEN = "oct_secondary_stale";
const OTHER_TOKEN = "oct_other_live";

async function downgradeToPreChangeShape({ multiAccount }) {
  // Faithful upgrade: build the real v114 database, then roll only the
  // credentials table back to the shape v25 shipped and mark v114 unapplied —
  // through the platform's own handle, because a second SQLite binding on the
  // same WAL file does not reliably see this one's commits.
  const raw = db.getDb();
  raw.exec("DROP TABLE user_connector_credentials");
  raw.exec(`CREATE TABLE user_connector_credentials (
    email TEXT NOT NULL,
    slot TEXT NOT NULL,
    token TEXT NOT NULL,
    pat_id TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, slot)
  )`);
  const seeded = [
    ["single@example.com", "default", PRIMARY_TOKEN, "pat-single", 0, 1, "2026-10-01T00:00:00.000Z"],
    ...(multiAccount
      ? [
          ["multi@example.com", "primary", OTHER_TOKEN, "pat-primary", 0, 1, "2026-10-01T00:00:00.000Z"],
          ["multi@example.com", "secondary", SECONDARY_TOKEN, null, 1, 0, "2026-09-01T00:00:00.000Z"],
        ]
      : []),
  ];
  const insert = raw.prepare(
    "INSERT INTO user_connector_credentials (email, slot, token, pat_id, stale, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of seeded) insert.run(...row);
  // The ledger is created by v114; a pre-change database has none.
  raw.exec("DROP TABLE IF EXISTS connector_binding_ledger");
  raw.prepare("DELETE FROM schema_migrations WHERE version >= 114").run();
  return seeded;
}

test("7.1 an upgraded single-account install injects the same token it injected before", async () => {
  await downgradeToPreChangeShape({ multiAccount: false });
  // Pre-upgrade behaviour, stated once: the global `connector` row resolved to
  // the active account's token. Everything below asserts the upgrade preserved
  // exactly that — same url, same Authorization, still one row.
  await db.initDb();

  const raw = await writePatch({ ownerEmail: "single@example.com" });
  const connectorRows = patchEntries(raw).filter((entry) => entry.config.serverName.startsWith("connector"));
  assert.equal(connectorRows.length, 1, "one connector row after the upgrade, not zero and not two");

  // The injected row's NAME is `bindingServerName(slot)` — dsh rejects colons in
  // MCP server names, so the ledger moved to a folded slug+hash and legacy
  // `connector:<slot>` names no longer resolve (see test-mcp-server-name.mjs:
  // "those rows are dead on this dsh"). Ask the generator; never hardcode a hash.
  const bindings7 = await import("../connector-bindings.js");
  const EXPLORE_ROW = bindings7.bindingServerName("chat:explore");
  const row = patchEntry(EXPLORE_ROW, raw);
  assert.ok(row, "the built-in exploration binding is the surviving row");
  assert.equal(row.config.url, "https://connector.example.test/mcp", "same transport as the retired template");
  assert.equal(row.config.headers.Authorization, `Bearer ${PRIMARY_TOKEN}`, "same credential as before the upgrade");

  // Specification vs. credential: the ref/slot stay server-side (4.2), so the
  // cell receives a resolved header and nothing to replay.
  assert.equal(row.config.credentialRef, undefined);
  assert.equal(row.config.slot, undefined);

  // The same action still resolves: hand the injected config to the server-side
  // ref resolver, which is what a tool call actually consults. This is the
  // equivalence claim — not "a row exists", but "the row authorizes".
  const resolved = await credentialRefs.resolveCredentials(
    { connector: { url: "https://connector.example.test/mcp", credentialRef: "connector-binding", slot: "chat:explore" } },
    "single@example.com",
  );
  assert.equal(resolved.omitted.length, 0, "the binding must not be omitted as unauthenticated");
  assert.equal(
    resolved.servers.connector.headers.Authorization,
    `Bearer ${PRIMARY_TOKEN}`,
    "the row authorizes with the pre-upgrade token",
  );

  // And it is stable: re-writing the profile after the upgrade does not churn
  // the file (a migration that re-minted or re-slotted would show up here).
  const again = await writePatch({ ownerEmail: "single@example.com" });
  assert.equal(again, raw, "the upgraded profile is byte-identical on re-apply");
});

test("7.2 multi-account stock keeps its primary and grants nothing", async () => {
  const seeded = await downgradeToPreChangeShape({ multiAccount: true });
  await db.initDb();
  const connectorCredentials = await import("../connector-credentials.js");
  const bindings = await import("../connector-bindings.js");
  const email = "multi@example.com";

  // Both accounts survive as accounts, and the originally active one is still
  // the primary — the upgrade does not pick for the user.
  const accounts = connectorCredentials.listForClient(email);
  assert.deepEqual(accounts.map((row) => row.slot).sort(), ["primary", "secondary"]);
  assert.equal(connectorCredentials.status(email).slot, "primary");
  assert.equal(connectorCredentials.liveToken(email), OTHER_TOKEN);

  // The stale account stays stale: preserved as a source, not revived and not
  // promoted to an injection candidate.
  const secondary = accounts.find((row) => row.slot === "secondary");
  assert.equal(secondary.stale, true);
  assert.equal(secondary.connected, false);

  // Nothing was granted: no pack binding in the ledger, so the only injected
  // connector row is the built-in exploration one.
  assert.deepEqual(bindings.listBindings(email), [], "the upgrade must not invent pack bindings");
  const injected = bindings.injectionRows(email).map((row) => row.slot);
  assert.deepEqual(injected, ["chat:explore"]);

  const raw = await writePatch({ ownerEmail: email });
  const connectorRows = patchEntries(raw).filter((entry) => entry.config.serverName.startsWith("connector"));
  assert.deepEqual(connectorRows.map((entry) => entry.config.serverName), [bindings.bindingServerName("chat:explore")]);
  assert.equal(connectorRows[0].config.headers.Authorization, `Bearer ${OTHER_TOKEN}`);

  // Same for the single-account identity seeded alongside: its own token, never
  // the neighbour's (per-identity isolation across the migration).
  const single = await writePatch({ ownerEmail: "single@example.com" });
  assert.equal(
    patchEntry(bindings.bindingServerName("chat:explore"), single).config.headers.Authorization,
    `Bearer ${PRIMARY_TOKEN}`,
  );
  assert.equal(seeded.length, 3);
});
