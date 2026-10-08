#!/usr/bin/env node
// ── Platform billing tests (add-agent-platform-ops; revised by
// revise-billing-key-acquisition) ────────────────────────────────────────────
//
// Module-level tests against injected sub2api stubs and the real deploy
// integration paths: client shapes (email resolution, key-ownership lookup,
// liveness probe, degraded mode), the paste-flow deploy gate (no-account 402,
// balance gate, four-layer key validation, binding lifecycle), and the
// internal key-distribution route's auth.
//
//   node --test scripts/test-platform-billing.mjs

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "platform-billing-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const { createSub2apiClient } = await import("../lib/sub2api-admin.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── stub sub2api (paste-flow surface: directory, key store, liveness) ───────

function stubSub2api() {
  const users = new Map(); // id → {id, email, username, balance, status, keys: [{key, dead}]}
  const seen = [];
  let nextId = 100;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    seen.push({ method: req.method, path: req.path, key: req.headers["x-api-key"] ?? null });
    if (req.path.startsWith("/api/v1/admin") && req.headers["x-api-key"] !== "admin-k") {
      return res.status(401).json({ code: 401, message: "Authorization required" });
    }
    next();
  });
  const ok = (res, data) => res.json({ code: 0, message: "success", data });
  const byId = (id) => [...users.values()].find((x) => String(x.id) === String(id));

  // Paste flow: the TEST mints keys by creating a user + key directly.
  const addUser = (email, { balance = 0 } = {}) => {
    const id = ++nextId;
    const u = { id, email, username: email.split("@")[0], balance, status: "active", keys: [] };
    users.set(id, u);
    return u;
  };
  const addKey = (u, { dead = false } = {}) => {
    const key = `sk-stub-${u.id}-${++nextId}`;
    u.keys.push({ key, dead });
    return key;
  };

  // Directory search: email/username substring + API-key VALUE substring
  // (the upstream behavior the ownership check leans on).
  app.get("/api/v1/admin/users", (req, res) => {
    const s = req.query.search ?? "";
    const items = [...users.values()].filter(
      (u) => u.email.includes(s) || u.username.includes(s) || u.keys.some((k) => k.key.includes(s)),
    );
    ok(res, { items, total: items.length });
  });
  app.post("/api/v1/admin/users", (req, res) => {
    ok(res, addUser(req.body.email));
  });
  app.put("/api/v1/admin/users/:id", (req, res) => {
    const u = byId(req.params.id);
    if (!u) return res.status(404).json({ code: 404, message: "not found" });
    ok(res, u);
  });
  app.get("/api/v1/admin/users/:id", (req, res) => {
    const u = byId(req.params.id);
    if (!u) return res.status(404).json({ code: 404, message: "not found" });
    ok(res, u);
  });
  app.post("/api/v1/admin/users/:id/balance", (req, res) => {
    const u = byId(req.params.id);
    if (!u) return res.status(404).json({ code: 404, message: "not found" });
    if (!req.headers["idempotency-key"]) return res.status(400).json({ code: 400, message: "idempotency key required" });
    u.balance += Number(req.body.balance || 0);
    ok(res, { balance: u.balance });
  });
  // Liveness: full billing gate over the sk- key (balance>0, alive, found).
  app.get("/v1/models", (req, res) => {
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const owner = [...users.values()].find((u) => u.keys.some((k) => k.key === key));
    if (!owner) return res.status(401).json({ code: "INVALID_KEY", message: "bad key" });
    const rec = owner.keys.find((k) => k.key === key);
    if (rec.dead) return res.status(403).json({ code: "KEY_DISABLED", message: "key disabled" });
    if (owner.balance <= 0) return res.status(403).json({ code: "INSUFFICIENT_BALANCE", message: "Insufficient account balance" });
    ok(res, { data: [{ id: "gpt-x" }] });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, users, seen, addUser, addKey, byId, port: server.address().port })
    );
  });
}

const wireTo = (stub) => (p, i) => fetch(`http://127.0.0.1:${stub.port}${p}`, i);

test("client: email resolution, key ownership, liveness probe; degraded without key", async () => {
  const stub = await stubSub2api();
  try {
    const c = createSub2apiClient({ baseUrl: `http://127.0.0.1:${stub.port}`, adminKey: "admin-k", fetchImpl: wireTo(stub) });
    assert.deepEqual(await c.selfCheck(), { ok: true });

    // Resolution is by email and exact — a substring neighbor must not match.
    const alice = stub.addUser("alice@x.test");
    stub.addUser("alice@x.test.example.org");
    const found = await c.findUserByEmail("alice@x.test");
    assert.equal(found.userId, alice.id);
    assert.equal(await c.findUserByEmail("nobody@x.test"), null);

    // Ownership: a full key value resolves to exactly its holder.
    const key = stub.addKey(alice);
    const holder = await c.findUserByKey(key);
    assert.equal(holder.userId, alice.id);
    assert.equal(await c.findUserByKey("sk-not-a-real-key"), null);

    // Liveness mirrors the real gate: dead → code, broke → code, funded → ok.
    stub.addKey(alice, { dead: true });
    const deadKey = alice.keys.at(-1).key;
    const dead = await c.probeKeyLiveness(deadKey);
    assert.equal(dead.ok, false);
    assert.equal(dead.code, "KEY_DISABLED");
    const broke = await c.probeKeyLiveness(key);
    assert.equal(broke.code, "INSUFFICIENT_BALANCE");
    alice.balance = 5;
    assert.deepEqual(
      { ok: (await c.probeKeyLiveness(key)).ok },
      { ok: true },
    );

    // Degraded mode: no key → selfCheck explains, admin calls not attempted.
    const d = createSub2apiClient({ baseUrl: `http://127.0.0.1:${stub.port}`, adminKey: "" });
    assert.equal(d.degraded(), true);
    assert.match((await d.selfCheck()).reason, /SUB2API_ADMIN_KEY/);
  } finally {
    stub.server.close();
  }
});

// ── deploy integration: gate, paste, reference, distribution, lifecycle ─────

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

function stubRegistryWire() {
  const skills = new Map();
  const agents = new Map();
  const calls = { skills: [], agents: [] };
  return {
    calls,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      let m = url.match(/^\/api\/skills\/(.+)$/);
      if (m && init.method === "PUT") {
        calls.skills.push({ path: m[1], body });
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 200, json: async () => ({ path: `/skills/${body.name}`, ...body }) };
      }
      if (url.startsWith("/api/skills/") && !init.method) {
        const name = url.split("/").pop();
        if (skills.has(name)) return { ok: true, status: 200, json: async () => ({ path: "/skills/" + name }) };
        return { ok: false, status: 404, json: async () => ({ detail: "nf" }) };
      }
      if (url === "/api/skills" && init.method === "POST") {
        calls.skills.push({ path: body.path, body });
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") return { ok: true, status: 200, json: async () => ({ path: m[1] }) };
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && !init.method) {
        if (agents.has(m[1])) return { ok: true, status: 200, json: async () => agents.get(m[1]) };
        return { ok: false, status: 404, json: async () => ({ detail: "nf" }) };
      }
      if (m && (init.method === "PUT" || init.method === "POST")) {
        calls.agents.push({ path: m[1], body });
        agents.set(m[1], body);
        return { ok: true, status: 200, json: async () => ({ path: m[1], ...body }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: "route" }) };
    },
  };
}

const MANIFEST = {
  name: "计费包",
  description: "billing e2e",
  skills: [{ name: "bill-skill", description: "d", content: "# c" }],
  mcpServers: [],
  agents: [{ id: "bill-agent", name: "B", persona: "p", serving: { protocol: "a2a" } }],
};

async function harness({ user, sub2api, getUser, manifest = MANIFEST }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });
  const app = express();
  const wire = stubRegistryWire();
  // A function-valued `sub2api` is re-read per request — tests flip the
  // wiring at runtime (cutover regression: degraded window between deploys).
  const currentSub2api = () => (typeof sub2api === "function" ? sub2api() : sub2api);
  registerPackRoutes(app, {
    registry,
    resolveUser: getUser ?? (() => user),
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: () => {
      const s = currentSub2api();
      return {
        registryUrl: "https://mcp.example.test", token: "runner-svc-token",
        runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test",
        fetchImpl: wire.fetch,
        sub2api: s ? { baseUrl: s.baseUrl, adminKey: "admin-k", fetchImpl: s.fetchImpl } : null,
      };
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    registry, packId: id, wire,
    close: () => new Promise((r) => server.close(r)),
    call: (method, p, { headers = {}, body } = {}) =>
      fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })),
  };
}

test("deploy: no sub2api config degrades to keyless; pasted keys are ignored", async () => {
  const h = await harness({ user: { email: "author@x", groups: [] } });
  try {
    const res = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, {
      body: { billingKeys: { "bill-agent": "sk-whatever" } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.billing.linked, false);
    assert.equal(res.body.deployed[0].billingKeyRef, undefined);
    assert.equal(h.wire.calls.agents[0].body.metadata.billing_key_ref, undefined);
  } finally {
    await h.close();
  }
});

test("deploy paste flow: no-account 402, key gate, four-layer validation, happy path, distribution", async () => {
  const stub = await stubSub2api();
  const user = { email: "deployer@x", groups: ["creators"] };
  const h = await harness({
    user,
    sub2api: { baseUrl: `http://127.0.0.1:${stub.port}`, fetchImpl: wireTo(stub) },
  });
  try {
    const deploy = (body) => h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { body });

    // No sub2api account for the deployer's email → structured 402 + panel.
    const noAccount = await deploy({});
    assert.equal(noAccount.status, 402, JSON.stringify(noAccount.body));
    assert.equal(noAccount.body.code, "NO_SUB2API_ACCOUNT");
    assert.ok(noAccount.body.panelUrl, "panel URL present");
    // billing/me agrees before any account exists: three-state contract.
    const preReadout = await h.call("GET", "/api/packs/billing/me");
    assert.equal(preReadout.body.linked, true);
    assert.equal(preReadout.body.accountState, "none");
    assert.equal(preReadout.body.balance, null);

    // Create the deployer's REAL account (as a panel SSO would) + fund it.
    const me = stub.addUser("deployer@x");
    const admin = createSub2apiClient({ baseUrl: `http://127.0.0.1:${stub.port}`, adminKey: "admin-k", fetchImpl: wireTo(stub) });
    await admin.adjustBalance({ userId: me.id, amountUsd: 10, idempotencyKey: "fund-1" });

    // Funded but keyless serving deploy → refused, no shared-quota fallback.
    const required = await deploy({});
    assert.equal(required.status, 400, JSON.stringify(required.body));
    assert.equal(required.body.code, "BILLING_KEY_REQUIRED");

    // Validation matrix, cheap layers first.
    const badShape = await deploy({ billingKeys: { "bill-agent": "not-a-key" } });
    assert.equal(badShape.body.code, "BILLING_KEY_INVALID");
    assert.equal(badShape.body.reason, "shape");
    const unknownAgent = await deploy({ billingKeys: { "no-such-agent": "sk-x-1" } });
    assert.equal(unknownAgent.body.reason, "unknown-agent");

    const myKey = stub.addKey(me);
    // A dead key (mine) fails liveness.
    stub.addKey(me, { dead: true });
    const deadKey = me.keys.at(-1).key;
    const dead = await deploy({ billingKeys: { "bill-agent": deadKey } });
    assert.equal(dead.body.reason, "liveness");
    // A live key owned by SOMEONE ELSE fails ownership.
    const stranger = stub.addUser("stranger@x");
    stranger.balance = 9;
    const foreignKey = stub.addKey(stranger);
    const foreign = await deploy({ billingKeys: { "bill-agent": foreignKey } });
    assert.equal(foreign.body.reason, "ownership");

    // Happy path: funded + my live key → bound, referenced, distributed.
    const res = await deploy({ billingKeys: { "bill-agent": myKey } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.billing.linked, true);
    const ref = res.body.deployed[0].billingKeyRef;
    assert.match(ref, /^pk_/);
    const meta = JSON.stringify(h.wire.calls.agents.at(-1).body.metadata);
    assert.ok(meta.includes("billing_key_ref"));
    assert.ok(!meta.includes(myKey), "no key value on the registry");

    const noauth = await h.call("GET", `/api/packs/internal/llm-key/${ref}`);
    assert.equal(noauth.status, 401);
    const ok = await h.call("GET", `/api/packs/internal/llm-key/${ref}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.keyValue, myKey);
    assert.equal(ok.body.agentId, "bill-agent");

    // billing/me reflects the resolved account; bindings report bound=true.
    const meReadout = await h.call("GET", "/api/packs/billing/me");
    assert.equal(meReadout.body.linked, true);
    assert.equal(meReadout.body.accountState, "ok");
    assert.equal(meReadout.body.balance, 10);
    const bindings = await h.call("GET", `/api/packs/${h.packId}/billing-bindings`);
    assert.equal(bindings.status, 200);
    assert.deepEqual(bindings.body, { "bill-agent": true });

    // Redeploy WITHOUT keys keeps the binding (revalidated) and reuses the ref.
    const keep = await deploy({});
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(keep.body.deployed[0].billingKeyRef, ref, "same opaque reference rides");

    // The kept key dies → the NEXT redeploy refuses with replace guidance.
    me.keys.find((k) => k.key === myKey).dead = true;
    const keptDead = await deploy({});
    assert.equal(keptDead.status, 400, JSON.stringify(keptDead.body));
    assert.equal(keptDead.body.code, "BILLING_KEY_INVALID");
    assert.equal(keptDead.body.reason, "liveness");

    // Replace with a fresh key → bound again under a NEW reference.
    me.balance += 5;
    const fresh = stub.addKey(me);
    const replace = await deploy({ billingKeys: { "bill-agent": fresh } });
    assert.equal(replace.status, 200, JSON.stringify(replace.body));
    assert.notEqual(replace.body.deployed[0].billingKeyRef, ref);
    const ok2 = await h.call("GET", `/api/packs/internal/llm-key/${replace.body.deployed[0].billingKeyRef}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(ok2.body.keyValue, fresh);

    // Explicit null on a serving agent is refused — keys are replaced, not removed.
    const nullRefusal = await deploy({ billingKeys: { "bill-agent": null } });
    assert.equal(nullRefusal.status, 400);
    assert.equal(nullRefusal.body.code, "BILLING_KEY_REQUIRED");
  } finally {
    await h.close();
    stub.server.close();
  }
});

test("cutover regression: registry descriptor keeps billing_key_ref across repeated deploys", async () => {
  // The facet cutover incident as a test: facet ran without SUB2API_ADMIN_KEY,
  // so a redeploy through it pushed a descriptor with no billing_key_ref and
  // the serving agent silently fell off its own key. Lock the healthy shape
  // (same ref rides repeated deploys), assert the degraded window is loud,
  // and prove the binding resumes untouched once the wiring returns.
  const stub = await stubSub2api();
  const wired = { baseUrl: `http://127.0.0.1:${stub.port}`, fetchImpl: wireTo(stub) };
  let current = wired;
  const h = await harness({ user: { email: "deployer@x", groups: ["creators"] }, sub2api: () => current });
  try {
    const deploy = (body) => h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { body });
    const me = stub.addUser("deployer@x", { balance: 10 });
    const myKey = stub.addKey(me);

    const first = await deploy({ billingKeys: { "bill-agent": myKey } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const ref = first.body.deployed[0].billingKeyRef;
    assert.match(ref, /^pk_/);
    assert.equal(h.wire.calls.agents.at(-1).body.metadata.billing_key_ref, ref);

    // Repeated same-version redeploys: the registry descriptor's reference is
    // unchanged, and the bookkeeping row still holds the same reference.
    const again = await deploy({});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.deployed[0].billingKeyRef, ref);
    assert.equal(
      h.wire.calls.agents.at(-1).body.metadata.billing_key_ref, ref,
      "descriptor keeps the same billing_key_ref across redeploys",
    );
    assert.deepEqual(h.registry.deploymentKeysForPack(h.packId).map((k) => k.keyRef), [ref]);

    // Degraded window (the incident shape): billing unlinked. The deploy still
    // succeeds keyless — now with a warning naming the binding it cannot
    // revalidate — and the pushed descriptor drops the reference.
    current = null;
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    let degraded;
    try {
      degraded = await deploy({});
    } finally {
      console.warn = origWarn;
    }
    assert.equal(degraded.status, 200, JSON.stringify(degraded.body));
    assert.equal(degraded.body.deployed[0].billingKeyRef, undefined);
    assert.equal(h.wire.calls.agents.at(-1).body.metadata.billing_key_ref, undefined);
    assert.ok(
      warns.some((w) => w.includes("billing unlinked") && w.includes("bill-agent")),
      `degraded redeploy names the stripped binding (warns: ${JSON.stringify(warns)})`,
    );

    // The store row survives the degraded window...
    assert.deepEqual(h.registry.deploymentKeysForPack(h.packId).map((k) => k.keyRef), [ref]);

    // ...and when the wiring returns (facet.yaml aa60f6f), the SAME reference
    // rides again — no re-paste needed.
    current = wired;
    const restored = await deploy({});
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.deployed[0].billingKeyRef, ref);
    assert.equal(
      h.wire.calls.agents.at(-1).body.metadata.billing_key_ref, ref,
      "same reference rides after the wiring returns",
    );
  } finally {
    await h.close();
    stub.server.close();
  }
});

test("deploy paste flow: one key cannot bind two agents of the same pack", async () => {
  const stub = await stubSub2api();
  const TWO = {
    ...MANIFEST,
    agents: [
      { id: "a1", name: "A1", persona: "p", serving: { protocol: "a2a" } },
      { id: "a2", name: "A2", persona: "p", serving: { protocol: "a2a" } },
    ],
  };
  const user = { email: "multi@x", groups: ["creators"] };
  const h = await harness({
    user, manifest: TWO,
    sub2api: { baseUrl: `http://127.0.0.1:${stub.port}`, fetchImpl: wireTo(stub) },
  });
  try {
    const me = stub.addUser("multi@x");
    me.balance = 10;
    const k1 = stub.addKey(me);
    const k2 = stub.addKey(me);
    // Same value twice → duplicate, refused before any probe/binding.
    const dup = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, {
      body: { billingKeys: { a1: k1, a2: k1 } },
    });
    assert.equal(dup.status, 400, JSON.stringify(dup.body));
    assert.equal(dup.body.reason, "duplicate");
    // Distinct keys → both agents bound.
    const ok = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, {
      body: { billingKeys: { a1: k1, a2: k2 } },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.deployed[0].billingKeyRef, /^pk_/);
    assert.match(ok.body.deployed[1].billingKeyRef, /^pk_/);
    assert.notEqual(ok.body.deployed[0].billingKeyRef, ok.body.deployed[1].billingKeyRef);
  } finally {
    await h.close();
    stub.server.close();
  }
});

test("binding lifecycle: an agent that stops serving drops its stale binding", async () => {
  const stub = await stubSub2api();
  const user = { email: "stale@x", groups: ["creators"] };
  const TWO = {
    ...MANIFEST,
    agents: [
      { id: "a1", name: "A1", persona: "p", serving: { protocol: "a2a" } },
      { id: "a2", name: "A2", persona: "p", serving: { protocol: "a2a" } },
    ],
  };
  const h = await harness({ user, manifest: TWO, sub2api: { baseUrl: `http://127.0.0.1:${stub.port}`, fetchImpl: wireTo(stub) } });
  try {
    const me = stub.addUser("stale@x");
    me.balance = 10;
    const k1 = stub.addKey(me);
    const k2 = stub.addKey(me);
    // v1: both serving agents bound (distinct keys).
    const v1 = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { body: { billingKeys: { a1: k1, a2: k2 } } });
    assert.equal(v1.status, 200, JSON.stringify(v1.body));
    assert.equal(h.registry.deploymentKeysForPack(h.packId).length, 2);
    // v2: a2's serving contract is gone; a1 keeps serving.
    h.registry.publishVersion({
      email: "author@x", id: h.packId,
      manifest: { ...MANIFEST, agents: [TWO.agents[0], { id: "a2", name: "A2", persona: "p" }] },
    });
    // Redeploy with no keys: a1's binding is kept, a2's stale binding dropped.
    const v2 = await h.call("POST", `/api/packs/${h.packId}/versions/2/deploy`, { body: {} });
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    const after = h.registry.deploymentKeysForPack(h.packId);
    assert.equal(after.length, 1, "stale binding dropped, kept one survives");
    assert.equal(after[0].agentId, "a1");
    // Null for the now-non-serving agent with nothing left to clear is refused.
    const nullClear = await h.call("POST", `/api/packs/${h.packId}/versions/2/deploy`, { body: { billingKeys: { a2: null } } });
    assert.equal(nullClear.status, 400, JSON.stringify(nullClear.body));
    assert.equal(nullClear.body.reason, "unknown-agent");
  } finally {
    await h.close();
    stub.server.close();
  }
});

// ── private-pack visibility (task 3.1): viewer × visibility matrix ──────────

test("private pack: owner sees and deploys; strangers 404 everywhere; admin sees", async () => {
  const file = path.join(tmpRoot, `packs-vis-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const PRIVATE = { ...MANIFEST, name: "私有包", visibility: "private" };
  const PUBLIC = { ...MANIFEST, name: "公开包" };
  const { id: privId } = registry.publish({ email: "owner@x", manifest: PRIVATE });
  const { id: pubId } = registry.publish({ email: "owner@x", manifest: PUBLIC });
  assert.equal(registry.packRowPublic(privId).visibility, "private");
  assert.equal(registry.packRowPublic(pubId).visibility, "public");

  const wire = stubRegistryWire();
  let user = { email: "owner@x", groups: [] };
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790",
      packsPublicBase: "https://packs.example.test", fetchImpl: wire.fetch,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  try {
    // Owner: private listed (badged via visibility field), detail ok, deploys.
    let list = await call("GET", "/api/packs");
    assert.ok(list.body.packs.some((x) => x.id === privId && x.visibility === "private"), "owner sees own private pack");
    assert.ok(list.body.packs.some((x) => x.id === pubId));
    let detail = await call("GET", `/api/packs/${privId}`);
    assert.equal(detail.status, 200);
    let dep = await call("POST", `/api/packs/${privId}/versions/1/deploy`);
    assert.equal(dep.status, 200, JSON.stringify(dep.body));

    // Stranger: private pack indistinguishable from nonexistent — list,
    // detail, version, subscribe, deploy ALL 404/absent; public still fine.
    user = { email: "stranger@x", groups: ["creators"] };
    list = await call("GET", "/api/packs");
    assert.ok(!list.body.packs.some((x) => x.id === privId), "stranger list hides private");
    assert.ok(list.body.packs.some((x) => x.id === pubId));
    for (const p of [`/api/packs/${privId}`, `/api/packs/${privId}/versions/1`]) {
      assert.equal((await call("GET", p)).status, 404, p);
    }
    assert.equal((await call("POST", `/api/packs/${privId}/subscribe`)).status, 404);
    assert.equal((await call("POST", `/api/packs/${privId}/versions/1/deploy`)).status, 404);
    assert.equal((await call("GET", `/api/packs/${privId}/billing-bindings`)).status, 404, "bindings hidden too");
    assert.equal((await call("POST", `/api/packs/${pubId}/subscribe`)).status, 200, "public still subscribable");

    // Admin: sees the private pack and can deploy it.
    user = { email: "ops@x", groups: ["admin", "creators"] };
    detail = await call("GET", `/api/packs/${privId}`);
    assert.equal(detail.status, 200);
    dep = await call("POST", `/api/packs/${privId}/versions/1/deploy`);
    assert.equal(dep.status, 200, "admin may deploy a private pack");
    // The registry entry for a private deploy carries private visibility.
    const payload = wire.calls.agents.at(-1).body;
    assert.equal(payload.visibility, "private");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("billing board: token-or-admin auth; degraded shape without sub2api", async () => {
  const h = await harness({ user: { email: "author@x", groups: [] } });
  try {
    const anon = await h.call("GET", "/api/packs/billing/board");
    assert.equal(anon.status, 401);
    const authed = await h.call("GET", "/api/packs/billing/board", { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(authed.status, 200);
    assert.equal(authed.body.degraded, true, "no sub2api config ⇒ degraded board");
    assert.ok(Array.isArray(authed.body.keys));
  } finally {
    await h.close();
  }
});
