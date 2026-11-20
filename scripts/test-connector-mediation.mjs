// Unit tests — mediated connector access
// (add-served-agent-connector-access D2/D5/D9).
// Run: node --test scripts/test-connector-mediation.mjs
//
// The dangerous direction of this feature is single: making a connector call
// as the deployer when it should have been the visitor (or refusing to call
// when it should have). So the suite is written around "did the connector get
// called, and as whom", not around return values alone:
//
//   1.x  no visitor scope        → deployer, and the connector is told so.
//   2.x  anonymous visitor       → deployer, reason visible; never actor.
//   3.x  registered visitor      → preflight first, then the call as the actor,
//                                  with the actor header on both.
//   4.x  unregistered scope      → NO CALL. This is the arm that turns a broken
//                                  link into "the deployer did it" if it ever
//                                  falls back.
//   5.x  preflight refusals      → NO CALL, and the reason names who must act.
//   6.x  connector unreachable   → NO CALL and NO fallback (D9 item 4).
//   7.x  wiring faults           → NO CALL, each named separately.
//   8.x  the actor header helper is one function, so preflight and call agree.

import test from "node:test";
import assert from "node:assert/strict";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ACTOR_HEADER,
  connectorHeaders,
  createConnectorMediation,
  SERVICE_IDENTITY_HINTS,
  serviceIdentityHint,
} from "../lib/connector-mediation.js";
import { createVisitorActorRegistry } from "../lib/visitor-actor-registry.js";

const SCOPE = "0123456789abcdef0123456789abcdef";
const PACK = "pack-1";
const AGENT = "agent-1";
const AGENT_PATH = "packs/pack-1/agent-1";
const BINDING = "shopify";
const SECRET_NAME = "connector_binding_shopify";
const PAT = "oct_live_pat";
const ORIGIN = "https://connector.example.test";

/** Everything the mediation touches, faked, with a call ledger. */
function harness({ preflight = () => ({ status: 200, body: { ok: true } }) } = {}) {
  const visitorActors = createVisitorActorRegistry();
  const calls = [];
  const preflights = [];
  const mediation = createConnectorMediation({
    registry: {
      deployments: (packId) =>
        packId === PACK ? [{ agentId: AGENT, agentPath: AGENT_PATH, deployedBy: "owner@example.com" }] : [],
      deploymentSecretsForPack: (packId) =>
        packId === PACK
          ? [{ packId, agentId: AGENT, name: SECRET_NAME, secretRef: "sec_x", secretValue: PAT }]
          : [],
    },
    visitorActors,
    connectorOrigin: () => ORIGIN,
    fetchImpl: async (url, init) => {
      preflights.push({ url, headers: init.headers });
      const out = preflight(url, init);
      if (out instanceof Error) throw out;
      return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
    },
    callTool: async (args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  });
  return {
    mediation,
    visitorActors,
    calls,
    preflights,
    register: (actor) => visitorActors.register({ packId: PACK, agentId: AGENT, agentPath: AGENT_PATH, scope: SCOPE, actor }),
    call: (over = {}) =>
      mediation.call({
        packId: PACK,
        agentId: AGENT,
        agentPath: AGENT_PATH,
        scope: SCOPE,
        bindingKey: BINDING,
        tool: "shopify.list_orders",
        args: { limit: 5 },
        ...over,
      }),
  };
}

test("1.1 no visitor scope runs as the deployer and says so", async () => {
  const h = harness();
  const out = await h.call({ scope: "" });
  assert.equal(out.ok, true);
  assert.equal(out.executedAs, "deployer");
  assert.equal(out.reason, "no_visitor_scope");
  assert.equal(h.preflights.length, 0); // no actor → nothing to preflight
  assert.equal(h.calls.length, 1);
});

test("2.1 an anonymous visitor falls back to the deployer, visibly", async () => {
  const h = harness();
  h.register(null);
  const out = await h.call();
  assert.equal(out.ok, true);
  assert.equal(out.executedAs, "deployer");
  assert.equal(out.reason, "visitor_identity_absent");
  assert.equal(out.actor, undefined);
  assert.equal(h.preflights.length, 0);
  assert.equal(h.calls.length, 1);
});

test("3.1 a registered visitor is preflighted, then called as the actor", async () => {
  const h = harness();
  h.register("oidc-sub-42");
  const out = await h.call();
  assert.equal(out.ok, true);
  assert.equal(out.executedAs, "actor");
  assert.equal(out.actor, "oidc-sub-42");
  assert.equal(out.reason, undefined);

  // The preflight asked as the actor...
  assert.equal(h.preflights.length, 1);
  assert.equal(h.preflights[0].url, `${ORIGIN}/api/tenant/service-whoami`);
  assert.equal(h.preflights[0].headers[ACTOR_HEADER], "oidc-sub-42");
  assert.equal(h.preflights[0].headers.Authorization, `Bearer ${PAT}`);

  // ...and so did the tool call, on every request the transport builds.
  assert.equal(h.calls.length, 1);
  const transport = h.calls[0].transportFactory(h.calls[0].endpoint, h.calls[0].bearer);
  assert.ok(transport instanceof StreamableHTTPClientTransport);
  assert.equal(h.calls[0].endpoint, `${ORIGIN}/mcp`);
  assert.equal(h.calls[0].bearer, PAT);
});

test("4.1 an unregistered scope makes NO call — the link is broken, not anonymous", async () => {
  const h = harness();
  const out = await h.call(); // never registered
  assert.equal(out.ok, false);
  assert.equal(out.code, "actor_registration_missing");
  assert.equal(h.preflights.length, 0);
  assert.equal(h.calls.length, 0); // the assertion this whole change turns on
});

test("4.2 an expired registration makes NO call either", async () => {
  const visitorActors = createVisitorActorRegistry({ ttlMs: 1 });
  const registry = {
    deployments: () => [{ agentId: AGENT, agentPath: AGENT_PATH }],
    deploymentSecretsForPack: () => [{ agentId: AGENT, name: SECRET_NAME, secretValue: PAT }],
  };
  const calls = [];
  const mediation = createConnectorMediation({
    registry,
    visitorActors,
    connectorOrigin: () => ORIGIN,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    callTool: async (a) => {
      calls.push(a);
      return { content: [], isError: false };
    },
  });
  visitorActors.register({ packId: PACK, agentId: AGENT, agentPath: AGENT_PATH, scope: SCOPE, actor: "sub-a" });
  await new Promise((r) => setTimeout(r, 5));
  const out = await mediation.call({
    packId: PACK,
    agentId: AGENT,
    agentPath: AGENT_PATH,
    scope: SCOPE,
    bindingKey: BINDING,
    tool: "t",
  });
  assert.equal(out.code, "actor_registration_missing");
  assert.equal(calls.length, 0);
});

// 5.2: the two refusals the visitor can fix themselves carry the connector's
// address; the two the operator must fix must NOT (a link there misdirects).
const SELF_SERVICE_CODES = new Set(["actor_unregistered", "consent_missing"]);

for (const code of ["actor_unregistered", "obo_disabled", "consent_missing", "actor_disabled"]) {
  test(`5.x a preflight refusal (${code}) makes NO call and carries its own hint`, async () => {
    const h = harness({ preflight: () => ({ status: 401, body: { error: { code } } }) });
    h.register("oidc-sub-42");
    const out = await h.call();
    assert.equal(out.ok, false);
    assert.equal(out.code, code);
    assert.equal(typeof out.hint, "string");
    assert.ok(out.hint.length > 0);
    assert.equal(h.calls.length, 0); // refused before any tool call
    // 5.2: exactly the self-service refusals name where to go, and it is the
    // same host the refused call went to.
    if (SELF_SERVICE_CODES.has(code)) {
      assert.ok(out.hint.includes(ORIGIN), `${code} hint should carry ${ORIGIN}, got: ${out.hint}`);
    } else {
      assert.ok(!out.hint.includes(ORIGIN), `${code} hint should NOT carry an address, got: ${out.hint}`);
    }
  });
}

test("5.2 with no configured origin the hint stays addressless (never a guessed link)", () => {
  const hint = serviceIdentityHint("actor_unregistered", null);
  assert.equal(hint, SERVICE_IDENTITY_HINTS.actor_unregistered);
  assert.ok(!hint.includes("http"));
  // trailing slashes must not produce a doubled separator
  assert.equal(
    serviceIdentityHint("consent_missing", "https://connector.example.test//"),
    `${SERVICE_IDENTITY_HINTS.consent_missing} (https://connector.example.test)`,
  );
});

test("6.1 an unreachable connector fails closed — no call, no deployer fallback", async () => {
  const h = harness({ preflight: () => new Error("ECONNREFUSED") });
  h.register("oidc-sub-42");
  const out = await h.call();
  assert.equal(out.ok, false);
  assert.equal(out.code, "connector_unreachable");
  assert.equal(h.calls.length, 0);
});

test("6.2 a preflight timeout fails closed too", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const h = harness({ preflight: () => timeout });
  h.register("oidc-sub-42");
  const out = await h.call();
  assert.equal(out.code, "connector_unreachable");
  assert.equal(h.calls.length, 0);
});

test("6.3 a preflight that answers an unexpected shape never becomes a success", async () => {
  const h = harness({ preflight: () => ({ status: 403, body: { error: { code: "not_a_service_token" } } }) });
  h.register("oidc-sub-42");
  const out = await h.call();
  assert.equal(out.ok, false);
  assert.equal(out.code, "connector_preflight_rejected");
  assert.equal(out.connectorCode, "not_a_service_token");
  assert.equal(h.calls.length, 0);
});

test("7.1 an unknown binding makes NO call", async () => {
  const h = harness();
  const out = await h.call({ bindingKey: "not-declared" });
  assert.equal(out.code, "binding_unwired");
  assert.equal(h.calls.length, 0);
});

test("7.2 an unknown deployment makes NO call", async () => {
  const h = harness();
  const out = await h.call({ packId: "ghost" });
  assert.equal(out.code, "deployment_identity_required");
  assert.equal(h.calls.length, 0);
});

test("7.3 a tool name or binding key is required", async () => {
  const h = harness();
  assert.equal((await h.call({ tool: "" })).code, "tool_required");
  assert.equal((await h.call({ bindingKey: "" })).code, "binding_unknown");
  assert.equal(h.calls.length, 0);
});

test("7.4 a caller-supplied agentPath cannot open a second registration key", async () => {
  const h = harness();
  h.register("oidc-sub-42");
  // The route stored under the deployment's agentPath; a bogus path still
  // resolves to the same deployment, so the actor is found.
  const out = await h.call({ agentPath: "not/a/real/path" });
  assert.equal(out.executedAs, "actor");
  assert.equal(out.actor, "oidc-sub-42");
});

test("8.1 connectorHeaders is the single source of the actor header", () => {
  assert.deepEqual(connectorHeaders("pat", "sub"), { Authorization: "Bearer pat", [ACTOR_HEADER]: "sub" });
  assert.deepEqual(connectorHeaders("pat", null), { Authorization: "Bearer pat" });
  assert.deepEqual(connectorHeaders("pat"), { Authorization: "Bearer pat" });
});

test("8.2 a tool-level error is classified as an error, never a success", async () => {
  const visitorActors = createVisitorActorRegistry();
  const mediation = createConnectorMediation({
    registry: {
      deployments: () => [{ agentId: AGENT, agentPath: AGENT_PATH }],
      deploymentSecretsForPack: () => [{ agentId: AGENT, name: SECRET_NAME, secretValue: PAT }],
    },
    visitorActors,
    connectorOrigin: () => ORIGIN,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "[invalid_argument] bad limit" }] }),
  });
  const out = await mediation.call({
    packId: PACK,
    agentId: AGENT,
    agentPath: AGENT_PATH,
    scope: "",
    bindingKey: BINDING,
    tool: "shopify.list_orders",
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "connector_tool_error");
  // Deployer fallback is still reported on a failure, so the UI can be honest
  // about whose account the failed attempt used.
  assert.equal(out.executedAs, "deployer");
});
