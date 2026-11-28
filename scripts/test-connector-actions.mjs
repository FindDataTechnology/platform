// Unit tests — runner-side mediated connector executor
// (add-served-agent-connector-access D2/D9).
// Run: node --test scripts/test-connector-actions.mjs
//
// What can break HERE is the forwarding contract, not the policy: the platform
// owns every identity decision. So the suite pins three things —
//
//   1.x  the listed bindings come from the descriptor, filtered to usable keys
//        (a row without a key is unusable: the agent cannot name it)
//   2.x  the call carries the turn's scope and the deployment identity, and
//        NOTHING that could be mistaken for a credential
//   3.x  the platform's answer arrives intact — code, hint, executedAs — so the
//        model can tell the visitor who must fix what. A payload-less answer
//        (proxy page, gateway 401) must not become a fake success.

import test from "node:test";
import assert from "node:assert/strict";
import { CHILD_VISIBLE_KEYS, createConnectorActions } from "../agent-runner/connector-actions.js";

const BASE = "https://packs.example.test";
const TOKEN = "runner-service-token";
const SCOPE = "0123456789abcdef0123456789abcdef";

/** A fake platform that records every request and answers a scripted body. */
function harness({ status = 200, body = { ok: true, executedAs: "actor", actor: "sub-a" }, throwError = null } = {}) {
  const requests = [];
  const actions = createConnectorActions({
    config: { packsBaseUrl: BASE, registryToken: TOKEN },
    log: { log: () => {}, warn: () => {} },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      if (throwError) throw throwError;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  });
  return { actions, requests };
}

const DEPLOY = { packId: "pack-1", agentId: "agent-1", agentPath: "packs/pack-1/agent-1", agent: "pack-1/agent-1" };

test("1.1 list answers the descriptor's keys and never touches the network", async () => {
  const { actions, requests } = harness();
  const out = await actions.handle({
    ...DEPLOY,
    bindings: [{ key: "shopify", serverName: "s1", secretName: "n1" }, { key: "wms" }, { serverName: "no-key" }, null],
    op: "list",
  });
  assert.deepEqual(out, { ok: true, bindings: [{ key: "shopify" }, { key: "wms" }] });
  assert.equal(requests.length, 0);
});

test("1.2 no bindings is an empty list, not an error", async () => {
  const { actions } = harness();
  assert.deepEqual(await actions.handle({ ...DEPLOY, bindings: [], op: "list" }), { ok: true, bindings: [] });
  assert.deepEqual(await actions.handle({ ...DEPLOY, op: "list" }), { ok: true, bindings: [] });
});

test("2.1 the call carries deployment identity, the turn's scope, and the tool", async () => {
  const { actions, requests } = harness();
  await actions.handle({
    ...DEPLOY,
    scope: SCOPE,
    op: "call",
    args: { binding: "shopify", tool: "shopify.list_orders", arguments: { limit: 5 } },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${BASE}/api/packs/internal/connector-action/pack-1/agent-1`);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(requests[0].body, {
    agent_path: "packs/pack-1/agent-1",
    scope: SCOPE,
    bindingKey: "shopify",
    tool: "shopify.list_orders",
    arguments: { limit: 5 },
  });
});

test("2.2 no visitor scope is sent as an absence, never as an empty string", async () => {
  // "" and absent mean the same thing to the platform (no visitor); sending a
  // blank key would be a third state nobody defined.
  const { actions, requests } = harness();
  await actions.handle({ ...DEPLOY, scope: null, op: "call", args: { binding: "s", tool: "t" } });
  assert.equal(Object.hasOwn(requests[0].body, "scope"), false);
});

test("2.3 the child's payload cannot smuggle a credential or an identity", async () => {
  const { actions, requests } = harness();
  await actions.handle({
    ...DEPLOY,
    scope: SCOPE,
    op: "call",
    args: { binding: "shopify", tool: "t", actor: "attacker", token: "steal", packId: "other-pack" },
  });
  // The body is built from the host's own fields; extra child keys are dropped.
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["agent_path", "arguments", "bindingKey", "scope", "tool"]);
  assert.equal(requests[0].body.tool, "t");
});

test("3.1 a refusal arrives intact, hint included", async () => {
  const body = {
    ok: false,
    code: "actor_unregistered",
    message: "Sign in to the connector once, then retry, to act with your own account.",
    hint: "Sign in to the connector once, then retry, to act with your own account.",
  };
  const { actions } = harness({ status: 401, body });
  const out = await actions.handle({ ...DEPLOY, scope: SCOPE, op: "call", args: { binding: "s", tool: "t" } });
  assert.deepEqual(out, body);
});

test("3.2 the deployer-fallback label survives — the UI must be able to say it", async () => {
  const body = { ok: true, executedAs: "deployer", reason: "visitor_identity_absent", text: "ok" };
  const { actions } = harness({ body });
  const out = await actions.handle({ ...DEPLOY, scope: SCOPE, op: "call", args: { binding: "s", tool: "t" } });
  assert.deepEqual(out, body);
});

// ── the C2 boundary at the child edge (D1/D9) ────────────────────────────────
//
// The platform's success payload carries `actor` — the visitor's raw OIDC
// subject — and `result`, the raw MCP reply. Neither may cross into the child:
// the first is exactly the identifier C2 says never reaches the serving plane,
// and the second is not in the tool's closed output schema. The child learns
// HOW the call ran, never WHO it ran as.

test("3.2b the subject and raw payload are stripped before the child sees them", async () => {
  const body = {
    ok: true,
    executedAs: "actor",
    actor: "oidc-sub-secret",
    reason: undefined,
    result: { content: [{ type: "text", text: "raw upstream" }] },
    text: "42 orders",
  };
  const { actions } = harness({ body });
  const out = await actions.handle({ ...DEPLOY, scope: SCOPE, op: "call", args: { binding: "s", tool: "t" } });
  assert.equal(out.ok, true);
  assert.equal(out.text, "42 orders");
  assert.equal(out.executedAs, "actor");
  assert.equal(Object.hasOwn(out, "actor"), false, "the subject must not reach the serving plane (C2)");
  assert.equal(Object.hasOwn(out, "result"), false, "the raw MCP reply is not in the tool schema");
  assert.doesNotMatch(JSON.stringify(out), /oidc-sub-secret/);
});

test("3.2c every key handed to the child is one the tool schema declares", async () => {
  // A whitelist, not a blacklist: a future platform field must not appear here
  // by default, or the closed schema rejects the whole result and the model
  // sees a tool failure instead of an answer.
  const body = { ok: true, executedAs: "actor", actor: "s", text: "t", surprise: "!", serviceTokenId: "tok" };
  const { actions } = harness({ body });
  const out = await actions.handle({ ...DEPLOY, scope: SCOPE, op: "call", args: { binding: "s", tool: "t" } });
  for (const key of Object.keys(out)) {
    assert.ok(CHILD_VISIBLE_KEYS.includes(key), `key '${key}' is not in the tool's declared output schema`);
  }
});

test("3.2d a refusal's diagnostic keys survive the whitelist", async () => {
  // The whitelist must not be so tight that it eats the reason the visitor
  // needs. httpStatus/connectorCode are host-side; code/hint/message are not.
  const body = { ok: false, code: "connector_unreachable", message: "unreachable", httpStatus: 502, connectorCode: "x" };
  const { actions } = harness({ status: 502, body });
  const out = await actions.handle({ ...DEPLOY, op: "call", args: { binding: "s", tool: "t" } });
  assert.equal(out.code, "connector_unreachable");
  assert.equal(out.message, "unreachable");
  assert.equal(out.httpStatus, 502);
  assert.equal(Object.hasOwn(out, "connectorCode"), false, "a connector-internal code is not the child's business");
});

test("3.3 a payload-less answer (proxy page, gateway 401) never becomes a success", async () => {
  const { actions } = harness({ status: 502, body: "<html>bad gateway</html>" });
  const out = await actions.handle({ ...DEPLOY, op: "call", args: { binding: "s", tool: "t" } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "platform");
  assert.equal(out.httpStatus, 502);
});

test("3.4 an unconfigured runner declines instead of calling somewhere else", async () => {
  const actions = createConnectorActions({ config: {}, log: { log: () => {}, warn: () => {} } });
  const out = await actions.handle({ ...DEPLOY, op: "call", args: { binding: "s", tool: "t" } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "not-configured");
});

test("3.5 a transport failure is reported as network, a timeout as timeout", async () => {
  const net = harness({ throwError: new Error("ECONNREFUSED") });
  assert.equal((await net.actions.handle({ ...DEPLOY, op: "call", args: { binding: "s", tool: "t" } })).reason, "network");

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const slow = harness({ throwError: timeout });
  assert.equal((await slow.actions.handle({ ...DEPLOY, op: "call", args: { binding: "s", tool: "t" } })).reason, "timeout");
});

test("4.1 a call without a binding or tool is refused before the network", async () => {
  const { actions, requests } = harness();
  assert.equal((await actions.handle({ ...DEPLOY, op: "call", args: { tool: "t" } })).reason, "invalid-request");
  assert.equal((await actions.handle({ ...DEPLOY, op: "call", args: { binding: "s" } })).reason, "invalid-request");
  assert.equal(requests.length, 0);
});

test("4.2 an unknown op and a missing deployment identity are refused", async () => {
  const { actions } = harness();
  assert.equal((await actions.handle({ ...DEPLOY, op: "open" })).reason, "unknown-op");
  assert.equal((await actions.handle({ packId: "", agentId: "a", op: "list" })).reason, "identity");
});
