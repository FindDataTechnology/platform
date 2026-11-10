#!/usr/bin/env node
// ── Deployment secrets tests (add-deployment-secrets 1.1/1.2) ────────────────
//
// Module-level tests against the real deploy integration paths: the secrets
// intake validation matrix, the descriptor's references-only discipline, the
// keep/unbind/drop lifecycle, the secret-free public surfaces, and the
// internal fetch route's auth + audit + masking. The runner side (fetch →
// pin → fail-loud) lives in scripts/test-agent-runner.mjs.
//
//   node --test scripts/test-deployment-secrets.mjs

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "deployment-secrets-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

// Registry wire stub (the test-platform-billing helper, verbatim shape): the
// deploy library talks to it through fetchImpl; `calls.agents` keeps every
// registered payload so "no value on the registry" is grep-able.
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
  name: "密钥包",
  description: "deployment secrets e2e",
  skills: [{ name: "sec-skill", description: "d", content: "# c" }],
  mcpServers: [],
  agents: [{ id: "sec-agent", name: "S", persona: "p", serving: { protocol: "a2a" } }],
};

const VALUE_A = "ghp_FAKErepoTOKEN1234567890abcdef";
const VALUE_B = "mk-mirror-9876543210zyxwvu";

async function harness({ user = { email: "author@x", groups: ["creators"] }, manifest = MANIFEST } = {}) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });
  const app = express();
  const wire = stubRegistryWire();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    // No sub2api wiring: secrets must bind with billing unlinked.
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "runner-svc-token",
      runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test",
      fetchImpl: wire.fetch,
      sub2api: null,
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
    deploy: (version = 1, body = {}) => fetch(`${base}/api/packs/${id}/versions/${version}/deploy`, {
      method: "POST",
      headers: body && Object.keys(body).length > 0 ? { "Content-Type": "application/json" } : {},
      body: body && Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })),
  };
}

test("1.1 deploy binds secrets: store rows, descriptor carries refs only, deploy surface masks, public faces value-free", async () => {
  const h = await harness();
  try {
    const res = await h.deploy(1, { secrets: { "sec-agent": { repo_token: VALUE_A, mirror_key: VALUE_B } } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.billing.linked, false, "secrets bind independently of the billing linkage");

    // Stored once, platform-side, under fresh opaque references.
    const rows = h.registry.deploymentSecretsForPack(h.packId);
    assert.equal(rows.length, 2);
    const byName = new Map(rows.map((r) => [r.name, r]));
    assert.equal(byName.get("repo_token").secretValue, VALUE_A);
    assert.equal(byName.get("mirror_key").secretValue, VALUE_B);
    const refA = byName.get("repo_token").secretRef;
    const refB = byName.get("mirror_key").secretRef;
    assert.match(refA, /^ws_[0-9a-f]{24}$/);
    assert.match(refB, /^ws_[0-9a-f]{24}$/);
    assert.notEqual(refA, refB);

    // The descriptor carries the references — never the values.
    const meta = h.wire.calls.agents.at(-1).body.metadata;
    assert.deepEqual(meta.secret_refs, { repo_token: refA, mirror_key: refB });
    const metaJson = JSON.stringify(meta);
    assert.ok(!metaJson.includes(VALUE_A) && !metaJson.includes(VALUE_B), "no value on the registry entry");

    // The deploy surface shows names + D6 masks; full refs and values never.
    const surface = res.body.deployed[0].secretRefs;
    assert.deepEqual(Object.keys(surface).sort(), ["mirror_key", "repo_token"]);
    for (const [name, ref, value] of [["repo_token", refA, VALUE_A], ["mirror_key", refB, VALUE_B]]) {
      assert.equal(surface[name], `${ref.slice(0, 8)}…${value.slice(-4)}`, `${name} masked per D6`);
      assert.ok(!surface[name].includes(ref), "no full reference on the deploy surface");
      assert.ok(!surface[name].includes(value), "no full value on the deploy surface");
    }
    assert.ok(!JSON.stringify(res.body).includes(VALUE_A) && !JSON.stringify(res.body).includes(VALUE_B));

    // Every other read surface (detail, version, listing, card payload) is
    // secret-free: the manifest never held the values either.
    for (const p of [`/api/packs/${h.packId}`, `/api/packs/${h.packId}/versions/1`, "/api/packs"]) {
      const r = await h.call("GET", p);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes(VALUE_A) && !text.includes(VALUE_B), `no value at ${p}`);
      assert.ok(!text.includes("secret_refs") || p.includes("versions"), `no refs leak at ${p}`);
    }
    const registryPayload = JSON.stringify(h.wire.calls.agents.at(-1).body);
    assert.ok(!registryPayload.includes(VALUE_A) && !registryPayload.includes(VALUE_B), "registry payload value-free");
  } finally {
    await h.close();
  }
});

test("1.1 intake validation matrix: name, shape, size, count, agent; nothing persists on refusal", async () => {
  const h = await harness();
  try {
    const deploy = (secrets) => h.deploy(1, { secrets });
    const reasons = async (secrets) => {
      const r = await deploy(secrets);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "SECRET_INVALID", JSON.stringify(r.body));
      return r.body.reason;
    };

    assert.equal(await reasons({ "sec-agent": { "Bad-Name": "v" } }), "name");
    assert.equal(await reasons({ "sec-agent": { "UPPER": "v" } }), "name");
    assert.equal(await reasons({ "sec-agent": { ["a".repeat(33)]: "v" } }), "name");
    assert.equal(await reasons({ "sec-agent": { ok_name: "" } }), "shape");
    assert.equal(await reasons({ "sec-agent": { ok_name: 42 } }), "shape");
    assert.equal(await reasons({ "sec-agent": { ok_name: "x".repeat(8 * 1024 + 1) } }), "size");
    assert.equal(await reasons({ nosuch: { ok_name: "v" } }), "unknown-agent");
    assert.equal(await reasons({ nosuch: { ok_name: null } }), "unknown-agent");
    assert.equal(
      await reasons({ "sec-agent": { n1: "v", n2: "v", n3: "v", n4: "v", n5: "v" } }),
      "count",
    );
    // Shape refusals for the agent map itself.
    const bad = await deploy({ "sec-agent": "not-an-object" });
    assert.equal(bad.status, 400);
    const arr = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { body: { secrets: [] } });
    assert.equal(arr.status, 400);
    assert.equal(h.registry.deploymentSecretsForPack(h.packId).length, 0, "refusals persist nothing");
  } finally {
    await h.close();
  }
});

test("1.1 lifecycle: omission keeps (same ref), null unbinds one name, re-paste rotates, stopped-serving drops", async () => {
  const TWO = {
    ...MANIFEST,
    agents: [
      { id: "a1", name: "A1", persona: "p", serving: { protocol: "a2a" } },
      { id: "a2", name: "A2", persona: "p", serving: { protocol: "a2a" } },
    ],
  };
  const h = await harness({ manifest: TWO });
  // The LAST registered payload is a2's; descriptors are per-agent.
  const metaFor = (agentId) => [...h.wire.calls.agents].reverse().find((c) => c.body.metadata.agentId === agentId).body.metadata;
  try {
    // v1: bindings on both agents.
    const v1 = await h.deploy(1, { secrets: { a1: { repo_token: VALUE_A, mirror_key: VALUE_B }, a2: { mirror_key: VALUE_B } } });
    assert.equal(v1.status, 200, JSON.stringify(v1.body));
    const rows = h.registry.deploymentSecretsForPack(h.packId);
    assert.equal(rows.length, 3);
    const refA = rows.find((r) => r.agentId === "a1" && r.name === "repo_token").secretRef;
    const refA2 = rows.find((r) => r.agentId === "a2" && r.name === "mirror_key").secretRef;

    // Omission keeps every binding under the SAME references.
    const keep = await h.deploy(1, {});
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    const metaKeep = metaFor("a1");
    assert.equal(metaKeep.secret_refs.repo_token, refA, "kept reference rides into the new descriptor");
    assert.ok(metaKeep.secret_refs.mirror_key);
    assert.deepEqual(Object.keys(metaFor("a2").secret_refs), ["mirror_key"]);

    // Explicit null unbinds exactly one name, leaving the other agent alone.
    const unbind = await h.deploy(1, { secrets: { a1: { mirror_key: null } } });
    assert.equal(unbind.status, 200, JSON.stringify(unbind.body));
    const meta = metaFor("a1");
    assert.equal(meta.secret_refs.repo_token, refA);
    const after = h.registry.deploymentSecretsForPack(h.packId);
    assert.deepEqual(
      after.map((r) => `${r.agentId}.${r.name}`).sort(),
      ["a1.repo_token", "a2.mirror_key"],
      "the nulled row is gone from the store; a2 untouched",
    );
    const bindings = await h.call("GET", `/api/packs/${h.packId}/secret-bindings`);
    assert.deepEqual(bindings.body, { a1: ["repo_token"], a2: ["mirror_key"] }, "bindings visible: names only");

    // Re-paste replaces under a FRESH reference; the old one stops resolving.
    const rotated = await h.deploy(1, { secrets: { a1: { repo_token: `${VALUE_A}-v2` } } });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.notEqual(h.registry.deploymentSecretsForPack(h.packId).find((r) => r.agentId === "a1").secretRef, refA, "fresh reference on re-paste");
    const oldFetch = await h.call("GET", `/api/packs/internal/secret/${refA}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(oldFetch.status, 404, "rotated-out reference no longer resolves");

    // The resulting count bound holds across deploys (4 + a new one refuses).
    const four = await h.deploy(1, { secrets: { a1: { s2: "v", s3: "v", s4: "v" } } });
    assert.equal(four.status, 200, JSON.stringify(four.body));
    const five = await h.deploy(1, { secrets: { a1: { s5: "v" } } });
    assert.equal(five.status, 400);
    assert.equal(five.body.reason, "count");

    // An agent that stops serving drops its bindings on redeploy.
    h.registry.publishVersion({
      email: "author@x",
      id: h.packId,
      manifest: { ...TWO, agents: [TWO.agents[0], { id: "a2", name: "A2", persona: "p" }] },
    });
    const v2 = await h.deploy(2, {});
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    const left = h.registry.deploymentSecretsForPack(h.packId);
    assert.equal(left.length, 4, "a2's stale binding dropped; a1's four survive");
    assert.ok(left.every((r) => r.agentId === "a1"));
    const droppedFetch = await h.call("GET", `/api/packs/internal/secret/${refA2}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(droppedFetch.status, 404, "the dropped binding's reference stops resolving");
    const nullClear = await h.deploy(2, { secrets: { a2: { mirror_key: null } } });
    assert.equal(nullClear.status, 400, JSON.stringify(nullClear.body));
    assert.equal(nullClear.body.reason, "unknown-agent", "nothing left to clear");
  } finally {
    await h.close();
  }
});

test("1.2 internal fetch route: service-credential gate, value round-trip, unknown ref 404, audit masked and value-free", async () => {
  const h = await harness();
  const logs = [];
  const origLog = console.log;
  try {
    const dep = await h.deploy(1, { secrets: { "sec-agent": { repo_token: VALUE_A } } });
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
    const ref = h.registry.deploymentSecretsForPack(h.packId)[0].secretRef;

    assert.equal((await h.call("GET", `/api/packs/internal/secret/${ref}`)).status, 401);
    assert.equal((await h.call("GET", `/api/packs/internal/secret/${ref}`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await h.call("GET", "/api/packs/internal/secret/ws_deadbeef")).status, 401, "gate precedes existence");

    console.log = (...args) => logs.push(args.join(" "));
    const ok = await h.call("GET", `/api/packs/internal/secret/${ref}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    console.log = origLog;
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.secretValue, VALUE_A);
    assert.equal(ok.body.agentId, "sec-agent");
    assert.equal(ok.body.name, "repo_token");
    assert.equal(ok.body.secretRef, ref);

    assert.equal((await h.call("GET", "/api/packs/internal/secret/ws_000000000000000000000000", { headers: { Authorization: "Bearer runner-svc-token" } })).status, 404);

    const audit = logs.join("\n");
    assert.match(audit, /deployment secret fetched by runner/);
    assert.match(audit, /sec-agent/);
    assert.match(audit, /repo_token/);
    assert.ok(!audit.includes(VALUE_A), "audit carries no secret material");
    assert.ok(!audit.includes(ref), "audit shows the masked reference, not the full one");
    assert.match(audit, /ws_[0-9a-f]{5}…/, "audit line carries the D6 mask");
  } finally {
    console.log = origLog;
    await h.close();
  }
});

test("1.1 secret-bindings readout is names-only; unknown pack 404", async () => {
  const h = await harness();
  try {
    const dep = await h.deploy(1, { secrets: { "sec-agent": { repo_token: VALUE_A, mirror_key: VALUE_B } } });
    assert.equal(dep.status, 200, JSON.stringify(dep.body));
    const r = await h.call("GET", `/api/packs/${h.packId}/secret-bindings`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { "sec-agent": ["mirror_key", "repo_token"] });
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(VALUE_A) && !text.includes(VALUE_B) && !/ws_/.test(text), "names only");
    assert.equal((await h.call("GET", "/api/packs/nope/secret-bindings")).status, 404);
  } finally {
    await h.close();
  }
});