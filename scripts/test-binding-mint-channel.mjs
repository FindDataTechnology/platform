#!/usr/bin/env node
// ── Credential-owner channel for deployment bindings ────────────────────────
//
// fix-deploy-binding-mint-process. Two processes, two kinds of reach:
//   • the cell holds the user's connector account (it mints);
//   • the market plane (facet) holds the deployment-secret store (it records).
// Whichever process is asked must not pretend the other's state is its own: the
// market plane used to answer `no_account` for "I cannot see this person at
// all", which reads like a user action and is really a topology fact.
//
// What is pinned here:
//   - local credential present ⇒ mint locally, never call the channel;
//   - local credential absent + channel configured ⇒ mint via the channel and
//     RECORD THE VALUE locally (the runner fetches from this store);
//   - channel failure degrades to a reported failure, never a crash and never a
//     silent success;
//   - revoke on the market plane goes through the owner too, and prunes only
//     inside the deploy: namespace.
//
//   node --test --test-force-exit scripts/test-binding-mint-channel.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "binding-channel-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { connector: { url: "https://connector.example.test/mcp", credentialRef: "connector" } } }),
);

const CHANNEL = "http://platform.internal:3100";
const FACET_TOKEN = "facet-internal-token";

const db = await import("../db.js");
const connectorCredentials = await import("../connector-credentials.js");
const deploymentBindings = await import("../deployment-bindings.js");

const OWNER = "deployer@example.test";
const PACK = "channel-pack";
const AGENT = "writer";

function seedSatisfied() {
  db.upsertConnectorBindingLedgerRow({
    email: OWNER,
    packId: PACK,
    packVersion: "1",
    bindingKey: "market",
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
    optional: false,
  });
}

test("a process that can see the account never calls the channel", async () => {
  await db.initDb();
  connectorCredentials.store({ email: OWNER, slot: "default", token: "oct_parent" });
  db.setConnectorCredentialActive(OWNER, "default");
  seedSatisfied();
  process.env.PLATFORM_INTERNAL_URL = CHANNEL;
  process.env.FACET_INTERNAL_TOKEN = FACET_TOKEN;

  const recorded = [];
  const calls = { channel: 0 };
  const minted = await deploymentBindings.mintDeploymentBindings({
    email: OWNER,
    packId: PACK,
    agentIds: [AGENT],
    record: (row) => recorded.push(row),
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.startsWith(CHANNEL)) {
        calls.channel += 1;
        return new Response(JSON.stringify({ ok: false, code: "should_not_happen" }), { status: 500 });
      }
      // The connector itself.
      return new Response(JSON.stringify({ token: "oct_child", id: "pat-1" }), { status: 200 });
    },
  });

  assert.equal(calls.channel, 0, "the credential owner mints locally");
  assert.equal(minted.granted.length, 1);
  assert.equal(recorded[0].secretValue, "oct_child");
});

test("a market-plane process mints through the owner and records the value locally", async () => {
  // Same identity, but this process has no account for them (the split topology).
  const MARKET_OWNER = "market@example.test";
  db.upsertConnectorBindingLedgerRow({
    email: MARKET_OWNER,
    packId: PACK,
    packVersion: "1",
    bindingKey: "market",
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
    optional: false,
  });
  assert.equal(deploymentBindings.hasLocalConnectorAccount(MARKET_OWNER), false);

  const recorded = [];
  const seen = [];
  const minted = await deploymentBindings.mintDeploymentBindings({
    email: MARKET_OWNER,
    packId: PACK,
    agentIds: [AGENT],
    record: (row) => recorded.push(row),
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      seen.push({ target, init });
      assert.ok(target.endsWith("/api/gateway/binding-mint-batch"), `expected the batch door, got ${target}`);
      assert.equal(init.headers["x-facet-token"], FACET_TOKEN, "the channel is authenticated");
      const body = JSON.parse(String(init.body));
      assert.deepEqual({ email: body.email, packId: body.packId, agentIds: body.agentIds },
        { email: MARKET_OWNER, packId: PACK, agentIds: [AGENT] });
      return new Response(
        JSON.stringify({
          ok: true,
          keys: ["market"],
          granted: [{ agentId: AGENT, bindingKey: "market", name: "connector_binding_market",
            secretRef: `sec_${PACK}_${AGENT}_connector_binding_market`, secretValue: "oct_from_owner", patId: "pat-owner" }],
          failed: [],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(minted.granted.length, 1);
  assert.equal(minted.granted[0].via, "channel", "the surface can say who minted");
  // The value must land where the RUNNER fetches it: this process's store.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].secretValue, "oct_from_owner");
  assert.equal(recorded[0].name, "connector_binding_market");
  assert.equal(recorded[0].deployer, MARKET_OWNER);
});

test("a refused channel degrades to a reported failure", async () => {
  const STRANGER = "channel-down@example.test";
  db.upsertConnectorBindingLedgerRow({
    email: STRANGER,
    packId: PACK,
    packVersion: "1",
    bindingKey: "market",
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
    optional: false,
  });
  const recorded = [];
  const minted = await deploymentBindings.mintDeploymentBindings({
    email: STRANGER,
    packId: PACK,
    agentIds: [AGENT],
    record: (row) => recorded.push(row),
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: "no_account" }), { status: 409 }),
  });

  assert.equal(minted.granted.length, 0);
  assert.equal(minted.failed[0].code, "no_account");
  assert.equal(recorded.length, 0, "nothing is stored for a refused mint");
});

test("without a channel the local answer stands (no_account, not a topology code)", async () => {
  const ORPHAN = "no-channel@example.test";
  db.upsertConnectorBindingLedgerRow({
    email: ORPHAN,
    packId: PACK,
    packVersion: "1",
    bindingKey: "market",
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
    optional: false,
  });
  delete process.env.PLATFORM_INTERNAL_URL;
  const minted = await deploymentBindings.mintDeploymentBindings({
    email: ORPHAN,
    packId: PACK,
    agentIds: [AGENT],
    record: () => assert.fail("must not record without a credential source"),
    fetchImpl: async () => assert.fail("must not reach the wire without a channel"),
  });
  assert.equal(minted.granted.length, 0);
  // Single-process deployments have no channel by design; their answer is the
  // local truth (this identity holds no connector account).
  assert.equal(minted.failed[0].code, "no_account");

  process.env.PLATFORM_INTERNAL_URL = CHANNEL;
});

test("prune on the market plane revokes through the owner, inside the deploy namespace", async () => {
  const MARKET_OWNER = "prune-market@example.test";
  assert.equal(deploymentBindings.hasLocalConnectorAccount(MARKET_OWNER), false);
  const seen = [];
  const out = await deploymentBindings.pruneDeploymentBindings({
    email: MARKET_OWNER,
    packId: PACK,
    agentIds: [AGENT],
    keepKeys: ["market"],
    secrets: [{ agentId: AGENT, name: "connector_binding_gone" }],
    remove: () => {},
    fetchImpl: async (url, init = {}) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, revoked: [`deploy:${PACK}:${AGENT}:gone`], failed: [] }), { status: 200 });
    },
  });

  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith("/api/gateway/binding-revoke"));
  assert.deepEqual(seen[0].body.agentIds, [AGENT], "the owner computes the keep-set from its own ledger");
  assert.deepEqual(out.revoked, [`deploy:${PACK}:${AGENT}:gone`]);
});

test.after(() => {
  delete process.env.PLATFORM_INTERNAL_URL;
  delete process.env.FACET_INTERNAL_TOKEN;
  fs.rmSync(TMP, { recursive: true, force: true });
});
