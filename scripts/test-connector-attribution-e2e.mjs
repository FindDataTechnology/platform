// Integration test — attribution crosses the whole seam
// (add-served-agent-connector-access 6.1/6.5).
// Run: node --test scripts/test-connector-attribution-e2e.mjs
//
// Every existing suite fakes its downstream hop: the runner tests fake the
// platform, the mediation tests fake the connector, the route tests fake the
// registry. Nobody crossed the one seam that can fail SILENTLY — the registration
// key. The facade POSTs an `agent_path`, the route resolves a deployment and
// stores the row under THAT deployment's `agentPath`, and mediation later looks
// it up again from the resolved deployment. If those two normalizations ever
// disagree, a registered visitor's call does not run as the deployer and does
// not error out: it fails closed as `actor_registration_missing`, i.e. "the link
// is broken" on every single call, or — worse for the DELETE — the end-of-turn
// drop misses and the row outlives its turn.
//
// So this suite wires the REAL route handler + the REAL registry + the REAL
// mediation, and stubs only the far edge (an HTTP connector that records exactly
// what identity it was handed). What it pins:
//
//   1.1  registered visitor → the connector sees the visitor's subject in
//        `x-oo-connector-actor-sub`, and the bearer is the binding's PAT
//   1.2  anonymous visitor → NO actor header, and the answer says "deployer"
//   1.3  the same scope registered for a DIFFERENT deployment path → fail
//        closed, and the connector is never called (this is the red arm: it is
//        what a key-normalization mismatch looks like from the outside)
//   1.4  end-of-turn DELETE under the same seam actually drops the row
//   1.5  no credential on the internal route → 401 and nothing registered

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { createVisitorActorRegistry } from "../lib/visitor-actor-registry.js";
import { deploymentBindingSecretName } from "../deployment-bindings.js";
import { createConnectorMediation, ACTOR_HEADER } from "../lib/connector-mediation.js";
import { registerInternalPackRoutes } from "../gateway/packs-internal-routes.js";

const PACK = "pack-e2e";
const AGENT = "agent-e2e";
const AGENT_PATH = "agents/e2e/AGENT.md";
const SCOPE = "0123456789abcdef0123456789abcdef";
const OTHER_SCOPE = "fedcba9876543210fedcba9876543210";
const DEPLOYER_TOKEN = "deployer-pat-must-never-travel";
const BINDING_PAT = "binding-pat-e2e";
const INTERNAL_TOKEN = "runner-service-token";

/** The far edge: a connector that records the identity of every request. */
function connectorStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization ?? null,
        actor: req.headers[ACTOR_HEADER.toLowerCase()] ?? null,
      });
      if (req.url === "/api/tenant/service-whoami") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Minimal MCP-over-HTTP so the REAL callLineTool can run: the identity
      // header is applied by the transport factory, so only a real client shows
      // us what the far edge is actually handed.
      let msg = {};
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        // fall through: answer with an empty result
      }
      if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
        res.statusCode = 202;
        res.end();
        return;
      }
      let result = {};
      if (msg.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "connector-stub", version: "0.0.0" },
        };
      } else if (msg.method === "tools/call") {
        result = { content: [{ type: "text", text: "ok" }], isError: false };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
    });
  });
  return { server, seen };
}

async function boot({ withInternalToken = true, withoutAgentPath = false } = {}) {
  const stub = connectorStub();
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${stub.server.address().port}`;

  const deployments = [
    {
      packId: PACK,
      agentId: AGENT,
      // A deployment record may legitimately carry no agentPath (single
      // deployment of that agent). Then the route resolves by agentId and stores
      // the key under "".
      ...(withoutAgentPath ? {} : { agentPath: AGENT_PATH }),
      facade: true,
      connectorBindings: [{ key: "crm" }],
    },
  ];
  const registry = {
    deployments: (packId) => (packId === PACK ? deployments : []),
    allDeployments: () => deployments,
    deploymentSecretsForPack: (packId) =>
      packId === PACK
        ? [{ agentId: AGENT, name: deploymentBindingSecretName("crm"), secretValue: BINDING_PAT }]
        : [],
  };
  const visitorActors = createVisitorActorRegistry();
  const deployConfig = () => ({ token: withInternalToken ? INTERNAL_TOKEN : "" });

  const app = express();
  registerInternalPackRoutes(app, {
    registry,
    deployConfig,
    visitorActors,
    connectorAction: createConnectorMediation({
      registry,
      visitorActors,
      connectorOrigin: () => origin,
    }),
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    stub,
    base,
    visitorActors,
    async register(scope, actor, { token = INTERNAL_TOKEN, agentPath = AGENT_PATH } = {}) {
      const res = await fetch(`${base}/api/packs/internal/visitor-actor/${PACK}/${AGENT}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ scope, actor, agent_path: agentPath }),
      });
      return { status: res.status, body: await res.json() };
    },
    async drop(scope, { token = INTERNAL_TOKEN, agentPath = AGENT_PATH } = {}) {
      const q = new URLSearchParams({ scope, agent_path: agentPath });
      const res = await fetch(`${base}/api/packs/internal/visitor-actor/${PACK}/${AGENT}?${q}`, {
        method: "DELETE",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, body: await res.json() };
    },
    async call(scope) {
      const res = await fetch(`${base}/api/packs/internal/connector-action/${PACK}/${AGENT}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({ scope, agent_path: AGENT_PATH, bindingKey: "crm", tool: "list_contacts" }),
      });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((r) => server.close(r));
      await new Promise((r) => stub.server.close(r));
    },
  };
}

test("1.1 a registered visitor's call reaches the connector AS THE VISITOR", async () => {
  const h = await boot();
  try {
    const reg = await h.register(SCOPE, "oidc-sub-visitor-1");
    assert.equal(reg.status, 200);

    const out = await h.call(SCOPE);
    assert.equal(out.body.ok, true, JSON.stringify(out.body));
    assert.equal(out.body.executedAs, "actor");

    const tool = h.stub.seen.find((s) => s.url !== "/api/tenant/service-whoami");
    assert.ok(tool, "the connector should have been called");
    assert.equal(tool.actor, "oidc-sub-visitor-1", "the visitor's subject must ride the actor header");
    assert.equal(tool.authorization, `Bearer ${BINDING_PAT}`);
    // The deployment's own credential is the binding PAT — nothing else may appear.
    assert.ok(!JSON.stringify(h.stub.seen).includes(DEPLOYER_TOKEN));
  } finally {
    await h.close();
  }
});

test("1.2 an anonymous visitor's call runs as the deployer AND SAYS SO — no actor header", async () => {
  const h = await boot();
  try {
    const reg = await h.register(OTHER_SCOPE, null); // explicit "this visitor has no identity"
    assert.equal(reg.status, 200);

    const out = await h.call(OTHER_SCOPE);
    assert.equal(out.body.ok, true, JSON.stringify(out.body));
    assert.equal(out.body.executedAs, "deployer");
    assert.equal(out.body.reason, "visitor_identity_absent");

    const tool = h.stub.seen.find((s) => s.url !== "/api/tenant/service-whoami");
    assert.ok(tool, "the connector should have been called");
    assert.equal(tool.actor, null, "an anonymous visitor must NOT carry someone's subject");
  } finally {
    await h.close();
  }
});

test("1.3 RED ARM — a registration under a different path fails closed, connector never called", async () => {
  // This is what a key-normalization mismatch looks like from the outside. Build
  // the row directly under another agentPath (as a second deployment of the same
  // agent would), then call the scope that only THAT path knows about.
  const h = await boot();
  try {
    h.visitorActors.register({ packId: PACK, agentId: AGENT, agentPath: "agents/other/AGENT.md", scope: SCOPE, actor: "oidc-sub-visitor-1" });

    const out = await h.call(SCOPE);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.code, "actor_registration_missing");
    assert.equal(
      h.stub.seen.filter((s) => s.url !== "/api/tenant/service-whoami").length,
      0,
      "a missing registration must not reach the connector at all",
    );
  } finally {
    await h.close();
  }
});

test("1.4 end-of-turn DELETE drops the row through the same seam", async () => {
  const h = await boot();
  try {
    assert.equal((await h.register(SCOPE, "oidc-sub-visitor-1")).status, 200);
    assert.equal(h.visitorActors.lookup({ packId: PACK, agentId: AGENT, agentPath: AGENT_PATH, scope: SCOPE }).state, "registered");

    const del = await h.drop(SCOPE);
    assert.equal(del.status, 200);
    // If the two normalizations disagreed, the row would still be here.
    assert.equal(h.visitorActors.lookup({ packId: PACK, agentId: AGENT, agentPath: AGENT_PATH, scope: SCOPE }).state, "missing");

    const out = await h.call(SCOPE);
    assert.equal(out.body.code, "actor_registration_missing");
  } finally {
    await h.close();
  }
});

test("1.5 without the internal credential nothing registers", async () => {
  const h = await boot();
  try {
    const reg = await h.register(SCOPE, "oidc-sub-visitor-1", { token: "" });
    assert.equal(reg.status, 401);
    assert.equal(h.visitorActors.size, 0);
  } finally {
    await h.close();
  }
});

test("1.6 a deployment with no agentPath still drops the row (the key is the record's, not the caller's)", async () => {
  // The silent shape: the record carries no agentPath, so register stores under
  // ""; a DELETE that normalized from the caller's `agent_path` would compute a
  // DIFFERENT key and miss, leaving the registration alive for the whole TTL
  // after the turn it described.
  const h = await boot({ withoutAgentPath: true });
  try {
    const reg = await h.register(SCOPE, "oidc-sub-visitor-1", { agentPath: "agents/e2e/AGENT.md" });
    assert.equal(reg.status, 200);
    assert.equal(h.visitorActors.lookup({ packId: PACK, agentId: AGENT, agentPath: "", scope: SCOPE }).state, "registered");

    const del = await h.drop(SCOPE, { agentPath: "agents/e2e/AGENT.md" });
    assert.equal(del.status, 200);
    assert.equal(
      h.visitorActors.lookup({ packId: PACK, agentId: AGENT, agentPath: "", scope: SCOPE }).state,
      "missing",
      "the end-of-turn delete must use the deployment's agentPath (\"\"), not the caller's string",
    );
  } finally {
    await h.close();
  }
});
