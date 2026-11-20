// Unit tests — visitor identity registration route
// (add-served-agent-connector-access D3/D4).
// Run: node --test scripts/test-visitor-actor-route.mjs
//
// The route is the ONLY place a scope→actor fact enters the serving plane, so
// its edges are the whole security story:
//
//   1.x  the service credential gates it (the facade's call, nobody else's).
//   2.x  the deployment must exist — an unbounded key space is a memory leak
//        with extra steps.
//   3.x  a raw identifier is refused: the wire carries the facade's opaque
//        scope and nothing else (C2).
//   4.x  `actor` is REQUIRED, and `null` is a distinct answer from silence.
//        Silence must fail closed; the route must never read an omitted key as
//        "this visitor has no identity", because that is the sentence that
//        would make a broken channel look like a working fallback.
//   5.x  turn end drops exactly one registration.

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerInternalPackRoutes } from "../gateway/packs-internal-routes.js";
import { createVisitorActorRegistry } from "../lib/visitor-actor-registry.js";

const TOKEN = "runner-service-token";
const SCOPE = "0123456789abcdef0123456789abcdef";
const PACK = "pack-1";
const AGENT = "agent-1";

/** A server over a fake registry with one known deployment. */
async function harness({ deployments = [{ agentId: AGENT, agentPath: "packs/pack-1/agent-1" }] } = {}) {
  const visitorActors = createVisitorActorRegistry();
  const app = express();
  registerInternalPackRoutes(app, {
    registry: { deployments: (packId) => (packId === PACK ? deployments : []) },
    deployConfig: () => ({ token: TOKEN }),
    visitorActors,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    visitorActors,
    post: (body, { path = `/api/packs/internal/visitor-actor/${PACK}/${AGENT}`, auth = TOKEN } = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    del: (query, { path = `/api/packs/internal/visitor-actor/${PACK}/${AGENT}`, auth = TOKEN } = {}) =>
      fetch(`${base}${path}?${new URLSearchParams(query)}`, {
        method: "DELETE",
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
      }),
    lookup: () => visitorActors.lookup({ packId: PACK, agentId: AGENT, agentPath: "packs/pack-1/agent-1", scope: SCOPE }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("1.1 no service credential → 401, and nothing is registered", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: SCOPE, actor: "sub-a" }, { auth: null });
    assert.equal(res.status, 401);
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("2.1 an unknown deployment → 404, and nothing is registered", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: SCOPE, actor: "sub-a" }, { path: `/api/packs/internal/visitor-actor/ghost/${AGENT}` });
    assert.equal(res.status, 404);
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("3.1 a raw identifier in place of the scope is refused (C2)", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: "alice@example.com", actor: "sub-a" });
    assert.equal(res.status, 400);
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("4.1 omitting `actor` is refused — silence is not 'anonymous'", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: SCOPE });
    assert.equal(res.status, 400);
    // The dangerous alternative would be a stored `anonymous`; assert it did
    // not happen.
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("4.2 an explicit null actor registers the anonymous FACT", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: SCOPE, actor: null });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(h.lookup().state, "anonymous");
  } finally {
    await h.close();
  }
});

test("4.3 a subject registers the actor", async () => {
  const h = await harness();
  try {
    const res = await h.post({ scope: SCOPE, actor: "oidc-sub-42" });
    assert.equal(res.status, 200);
    assert.deepEqual(h.lookup(), { state: "registered", actor: "oidc-sub-42" });
  } finally {
    await h.close();
  }
});

test("4.4 a blank or non-string actor is refused", async () => {
  const h = await harness();
  try {
    assert.equal((await h.post({ scope: SCOPE, actor: "   " })).status, 400);
    assert.equal((await h.post({ scope: SCOPE, actor: 42 })).status, 400);
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("5.1 turn end forgets exactly that registration", async () => {
  const h = await harness();
  try {
    await h.post({ scope: SCOPE, actor: "sub-a" });
    assert.equal(h.lookup().state, "registered");
    const res = await h.del({ scope: SCOPE, agent_path: "packs/pack-1/agent-1" });
    assert.equal(res.status, 200);
    assert.equal(h.lookup().state, "missing");
  } finally {
    await h.close();
  }
});

test("5.2 the delete route is credential-gated too", async () => {
  const h = await harness();
  try {
    await h.post({ scope: SCOPE, actor: "sub-a" });
    const res = await h.del({ scope: SCOPE }, { auth: null });
    assert.equal(res.status, 401);
    assert.equal(h.lookup().state, "registered");
  } finally {
    await h.close();
  }
});

test("the registration is keyed to the deployment the route resolved", async () => {
  // A caller that names a different (unknown) agentPath still lands on the
  // deployment the route matched, so a bogus path cannot create a side key.
  const h = await harness();
  try {
    await h.post({ scope: SCOPE, actor: "sub-a", agent_path: "not/a/real/path" });
    assert.deepEqual(h.lookup(), { state: "registered", actor: "sub-a" });
  } finally {
    await h.close();
  }
});

// ── the mediated action route is a thin shell; pin the shell ────────────────
//
// Everything that matters is in lib/connector-mediation.js (see
// test-connector-mediation.mjs). What can break HERE is the wiring: a renamed
// body field, a status map that reports "we called nothing" as 200.

async function actionHarness(out) {
  const seen = [];
  const app = express();
  registerInternalPackRoutes(app, {
    registry: { deployments: (packId) => (packId === PACK ? [{ agentId: AGENT, agentPath: "packs/pack-1/agent-1" }] : []) },
    deployConfig: () => ({ token: TOKEN }),
    connectorAction: {
      call: async (input) => {
        seen.push(input);
        return out;
      },
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    seen,
    post: (body, { auth = TOKEN } = {}) =>
      fetch(`${base}/api/packs/internal/connector-action/${PACK}/${AGENT}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("action route forwards binding/tool/arguments/scope under the service gate", async () => {
  const h = await actionHarness({ ok: true, executedAs: "actor", actor: "sub-a", text: "ok", result: {} });
  try {
    const res = await h.post({
      bindingKey: "shopify",
      tool: "shopify.list_orders",
      arguments: { limit: 5 },
      scope: SCOPE,
      agent_path: "packs/pack-1/agent-1",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(h.seen[0], {
      packId: PACK,
      agentId: AGENT,
      agentPath: "packs/pack-1/agent-1",
      scope: SCOPE,
      bindingKey: "shopify",
      tool: "shopify.list_orders",
      args: { limit: 5 },
    });
    assert.deepEqual(await res.json(), { ok: true, executedAs: "actor", actor: "sub-a", text: "ok", result: {} });
  } finally {
    await h.close();
  }
});

test("action route requires the service credential and never reaches the executor", async () => {
  const h = await actionHarness({ ok: true, executedAs: "deployer" });
  try {
    const res = await h.post({ bindingKey: "shopify", tool: "t" }, { auth: null });
    assert.equal(res.status, 401);
    assert.equal(h.seen.length, 0);
  } finally {
    await h.close();
  }
});

test("a fail-closed refusal is not reported as a successful round trip", async () => {
  // The status map exists so a monitor can tell "we called nothing because the
  // registration link is broken" from "the connector answered".
  const h = await actionHarness({ ok: false, code: "actor_registration_missing", message: "broken link" });
  try {
    const res = await h.post({ bindingKey: "shopify", tool: "t", scope: SCOPE });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, code: "actor_registration_missing", message: "broken link" });
  } finally {
    await h.close();
  }

  const unreachable = await actionHarness({ ok: false, code: "connector_unreachable", message: "down" });
  try {
    assert.equal((await unreachable.post({ bindingKey: "shopify", tool: "t" })).status, 502);
  } finally {
    await unreachable.close();
  }

  const bad = await actionHarness({ ok: false, code: "tool_required", message: "no tool" });
  try {
    assert.equal((await bad.post({ bindingKey: "shopify" })).status, 400);
  } finally {
    await bad.close();
  }
});
