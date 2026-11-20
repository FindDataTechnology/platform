#!/usr/bin/env node
// ── Deployment-scoped connector bindings, through the real composer
//
// add-deployment-binding-grant 3.3, harnessed at module level. The live drill
// needs an authenticated deployer (OIDC) and a published pack declaring a
// binding; prod has neither yet. The HTTP harness for the deploy route is not a
// substitute here: `test-deployment-secrets.mjs` hangs on the same route at
// baseline (the response never lands), so a new HTTP test would inherit a
// broken bench and prove nothing.
//
// What this file does prove, against the shipped code paths:
//   - a minted binding token is STORED with the deployer on record;
//   - the descriptor names the secret AND lists it in `secret_refs`, which is
//     the only map the runner fetches by — a token outside it would look
//     granted and be unusable;
//   - a redeploy that dropped the binding revokes the connector token, not
//     just its local row;
//   - the interactive `pack:` token namespace is never reachable from pruning.
//
//   node --test --test-force-exit scripts/test-deployment-binding-descriptor.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "binding-descriptor-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const CONNECTOR = "https://connector.example.test";
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { connector: { url: `${CONNECTOR}/mcp`, credentialRef: "connector" } } }),
);

const db = await import("../db.js");
const connectorCredentials = await import("../connector-credentials.js");
const deploymentBindings = await import("../deployment-bindings.js");
const { composeDescriptor } = await import("../lib/agent-serving.js");

const OWNER = "deployer@example.test";
const PACK = "descriptor-pack";
const AGENT = "writer";
const KEY = "market";

const pats = new Map(); // name → id
let seq = 0;
const revoked = [];
const connectorStub = async (url, init = {}) => {
  const target = String(url);
  const pathname = new URL(target).pathname;
  const method = init.method ?? "GET";
  if (pathname === "/api/tenant/pats" && method === "POST") {
    const body = JSON.parse(String(init.body || "{}"));
    const id = `pat-${++seq}`;
    // The connector revokes a replaced same-name token; mirror that so a
    // shared name would be caught here as a lost credential.
    pats.set(body.name, id);
    return new Response(JSON.stringify({ token: `oct_${seq}`, id, name: body.name }), { status: 200 });
  }
  if (pathname === "/api/tenant/pats" && method === "GET") {
    return new Response(
      JSON.stringify({ pats: [...pats].map(([name, id]) => ({ id, name, purpose: null })) }),
      { status: 200 },
    );
  }
  if (pathname.startsWith("/api/tenant/pats/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    for (const [name, v] of pats) if (v === id) pats.delete(name);
    revoked.push(id);
    return new Response(JSON.stringify({ id, revoked: true }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
};

function seedSatisfied(status = "satisfied") {
  db.upsertConnectorBindingLedgerRow({
    email: OWNER,
    packId: PACK,
    packVersion: "1",
    bindingKey: KEY,
    provider: "alpha_vantage",
    operations: ["read"],
    status,
    optional: false,
  });
}

// The deploy route's own steps, in its own order: mint → record → fold the
// secret name into secretRefs → describe.
async function deployLike({ email = OWNER } = {}) {
  const stored = [];
  const secretRefs = {};
  const minted = await deploymentBindings.mintDeploymentBindings({
    email,
    packId: PACK,
    agentIds: [AGENT],
    record: (row) => stored.push(row),
    fetchImpl: connectorStub,
  });
  const rows = {};
  for (const granted of minted.granted) {
    secretRefs[granted.name] = `sec_${PACK}_${granted.agentId}_${granted.name}`;
    rows[granted.agentId] ??= [];
    rows[granted.agentId].push({
      serverName: `connector:${PACK}:${granted.bindingKey}`,
      url: `${CONNECTOR}/mcp`,
      secretName: granted.name,
    });
  }
  const descriptor = composeDescriptor({
    packId: PACK,
    version: 1,
    // The role's skills come from the manifest; the binding path does not use
    // them, so an empty declaration is the honest minimum here.
    manifest: { name: "p", description: "d", skills: [], mcpServers: [], agents: [{ id: AGENT, name: "W", persona: "p", serving: { protocol: "a2a" } }] },
    agent: { id: AGENT, name: "W", persona: "p", serving: { protocol: "a2a" } },
    connectorBindings: rows[AGENT] ?? null,
    secretRefs,
    registryPath: `/packs/${PACK}/${AGENT}`,
    // Same shape the route passes when nothing else is set.
    runnerBaseUrl: "http://runner:8790",
    packsPublicBase: "https://packs.example.test",
    registryUrl: "https://mcp.example.test",
    token: "svc",
  });
  return { minted, stored, descriptor, secretRefs, rows };
}

test("a minted binding lands in the descriptor AND in the map the runner fetches", async () => {
  await db.initDb();
  connectorCredentials.store({ email: OWNER, slot: "default", token: "oct_parent" });
  db.setConnectorCredentialActive(OWNER, "default");
  seedSatisfied();

  const { minted, stored, descriptor, secretRefs } = await deployLike();
  assert.equal(minted.granted.length, 1, JSON.stringify(minted.failed));

  // Stored platform-side, deployer on record, token absent from the payload.
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "connector_binding_market");
  assert.match(stored[0].secretValue, /^oct_/);
  assert.equal(stored[0].deployer, OWNER);
  assert.ok(!JSON.stringify(minted).includes(stored[0].secretValue));

  // The descriptor names the secret; secret_refs is what the runner fetches by.
  assert.ok(secretRefs.connector_binding_market, "the name is in the fetched map");
  assert.deepEqual(descriptor.connector_bindings, [
    { serverName: `connector:${PACK}:market`, url: `${CONNECTOR}/mcp`, secretName: "connector_binding_market" },
  ]);
  assert.deepEqual(descriptor.secret_refs, { connector_binding_market: secretRefs.connector_binding_market });
  assert.ok(!JSON.stringify(descriptor).includes(stored[0].secretValue), "the token never rides the descriptor");
});

test("a redeploy that dropped the binding revokes the connector token", async () => {
  const patName = deploymentBindings.deploymentBindingPatName(PACK, AGENT, KEY);
  assert.ok(pats.has(patName), "the first deploy minted it");

  // The pack dropped the binding: the ledger says history, not requirement.
  seedSatisfied("deprecated");
  const removed = [];
  const result = await deploymentBindings.pruneDeploymentBindings({
    email: OWNER,
    packId: PACK,
    agentIds: [AGENT],
    keepKeys: [],
    secrets: [{ agentId: AGENT, name: "connector_binding_market" }],
    remove: (agentId, name) => removed.push(`${agentId}/${name}`),
    fetchImpl: connectorStub,
  });

  assert.deepEqual(removed, [`${AGENT}/connector_binding_market`]);
  assert.ok(!pats.has(patName), "the token is revoked on the connector, not just forgotten locally");
  assert.equal(result.revoked.length, 1);
  assert.deepEqual(result.failed, []);

  // And a deploy without the binding carries no connector row at all.
  const { descriptor } = await deployLike();
  assert.equal(descriptor.connector_bindings, undefined);
  assert.equal(descriptor.secret_refs, undefined);
});

test("pruning cannot reach a token a person granted by hand", async () => {
  // The interactive namespace for the same pack and key.
  pats.set(`pack:${PACK}:${KEY}`, "pat-hand");
  await deploymentBindings.pruneDeploymentBindings({
    email: OWNER,
    packId: PACK,
    agentIds: [],
    keepKeys: [],
    secrets: [],
    remove: () => assert.fail("no binding secret to remove"),
    fetchImpl: connectorStub,
  });
  assert.ok(pats.has(`pack:${PACK}:${KEY}`), "hand-granted tokens live outside the deploy namespace");
});

test("a failed mint deploys nothing and revokes nothing", async () => {
  // The previous test left the ledger deprecated; a failed mint needs a binding
  // the deployment still intends to carry.
  // A satisfied binding with no parent account at all: the ledger says the
  // binding is resolvable, yet there is no credential to attenuate from.
  const STRANGER = "no-account@example.test";
  db.upsertConnectorBindingLedgerRow({
    email: STRANGER,
    packId: PACK,
    packVersion: "1",
    bindingKey: KEY,
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
    optional: false,
  });
  const before = revoked.length;
  const { minted, stored, descriptor } = await deployLike({ email: STRANGER });
  assert.equal(minted.granted.length, 0);
  assert.equal(minted.failed[0].code, "no_account");
  assert.equal(stored.length, 0);
  assert.equal(descriptor.connector_bindings, undefined);
  assert.equal(revoked.length, before, "a transient failure must not revoke a working credential");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
