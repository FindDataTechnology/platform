#!/usr/bin/env node
// ── Facet platform tests (add-facet-platform tasks 2.2/2.3/2.5) ──────────────
//
// Module-level coverage for the S1 pieces: the anonymous open read face on
// the packs routes (public live packs only; private/unlisted invisible;
// write routes still wall), the proxy identity channel (forged forwarded
// headers are ignored without the internal credential), and 壹座's
// embedded-facet proxy (identity stamping, pass-through, unreachable→502).
//
//   node --test scripts/test-facet-platform.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "facet-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");
const { proxyIdentity, createResolveUser } = await import("../facet/identity.js");
const { registerFacetProxy } = await import("../gateway/facet-proxy.js");

const MANIFEST = (over = {}) => ({
  name: "Pub",
  description: "public pack",
  visibility: "public",
  tags: ["t1"],
  skills: [{ name: "s", description: "d", content: "# s" }],
  mcpServers: [],
  agents: [{ id: "a1", name: "A1", persona: "p" }],
  ...over,
});

function seedRegistry() {
  const reg = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmp, "reg-")), "packs.db") });
  const pub = reg.publish({ email: "creator@x", manifest: MANIFEST() });
  const priv = reg.publish({ email: "creator@x", manifest: MANIFEST({ name: "Priv", visibility: "private" }) });
  return { reg, pub, priv };
}

function mountApp(reg, { anonymousRead }) {
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    resolveUser: () => null, // every caller anonymous
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
    anonymousRead,
  });
  const server = http.createServer(app);
  server.listen(0);
  return server;
}

// ── 2.3 anonymous open read face ─────────────────────────────────────────────

test("2.3 anonymousRead: public packs browsable, downloadable; private invisible; writes still 401", async () => {
  const { reg, pub, priv } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/packs`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.packs[0].id, pub.id);

    const detail = await (await fetch(`${base}/api/packs/${pub.id}`)).json();
    assert.equal(detail.id, pub.id);
    assert.equal(detail.manifest.skills[0].name, "s");

    const ver = await (await fetch(`${base}/api/packs/${pub.id}/versions/1`)).json();
    assert.equal(ver.version, 1);

    // skill.md was already anonymous before facet; stays so.
    const md = await (await fetch(`${base}/api/packs/${pub.id}/versions/1/skills/s.md`)).text();
    assert.match(md, /# s/);

    // Private: detail and version answer not-found, and it is absent from list.
    assert.equal((await fetch(`${base}/api/packs/${priv.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/packs/${priv.id}/versions/1`)).status, 404);

    // Write routes keep the wall.
    assert.equal((await fetch(`${base}/api/packs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: MANIFEST() }) })).status, 401);
    assert.equal((await fetch(`${base}/api/packs/${pub.id}/subscribe`, { method: "POST" })).status, 401);
  } finally {
    reg.close();
    await new Promise((r) => server.close(r));
  }
});

// ── version history visibility + notes (add-facet-version-history) ──────────

test("version history follows detail visibility and carries notes", async () => {
  const reg = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmp, "reg-")), "packs.db") });
  const pub = reg.publish({ email: "creator@x", manifest: MANIFEST({ notes: "初版：检索骨架。" }) });
  reg.publishVersion({ email: "creator@x", id: pub.id, manifest: MANIFEST({ notes: "v2：修复超时。" }) });
  const unlisted = reg.publish({ email: "creator@x", manifest: MANIFEST({ name: "Unl" }) });
  reg.setUnlisted({ email: "creator@x", id: unlisted.id });
  const priv = reg.publish({ email: "creator@x", manifest: MANIFEST({ name: "Priv", visibility: "private", notes: "私有版注。" }) });

  const server = mountApp(reg, { anonymousRead: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Public pack: the anonymous viewer lists versions newest-first, notes inline.
    const r = await fetch(`${base}/api/packs/${pub.id}/versions`);
    assert.equal(r.status, 200);
    const { versions } = await r.json();
    assert.deepEqual(
      versions.map((v) => [v.version, v.notes]),
      [
        [2, "v2：修复超时。"],
        [1, "初版：检索骨架。"],
      ],
    );
    assert.equal(typeof versions[0].publishedAt, "number");
    assert.equal(versions[0].authorEmail, "creator@x");

    // Private and unlisted: not-found for the anonymous caller — same
    // posture as the detail route (probing teaches nothing).
    assert.equal((await fetch(`${base}/api/packs/${priv.id}/versions`)).status, 404);
    assert.equal((await fetch(`${base}/api/packs/${unlisted.id}/versions`)).status, 404);
  } finally {
    reg.close();
    await new Promise((r) => server.close(r));
  }
});

test("2.3 default mount (anonymousRead off) keeps the login wall", async () => {
  const { reg } = seedRegistry();
  const server = mountApp(reg, { anonymousRead: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/packs`)).status, 401);
    assert.equal((await fetch(`${base}/api/packs/nonexistent`)).status, 401);
  } finally {
    reg.close();
    await new Promise((r) => server.close(r));
  }
});

// ── 2.2 proxy identity channel ───────────────────────────────────────────────

test("2.2 proxyIdentity: forged forwarded headers are ignored; token-gated identity resolves", () => {
  const user = { email: "u@x", groups: ["creators"] };
  const forwarded = Buffer.from(JSON.stringify(user)).toString("base64url");
  const noToken = { headers: { "x-facet-user": forwarded } };
  assert.equal(proxyIdentity(noToken, "tok"), null, "header without credential → anonymous");
  assert.equal(proxyIdentity({ headers: {} }, "tok"), null);
  assert.equal(proxyIdentity({ headers: { "x-facet-token": "wrong", "x-facet-user": forwarded } }, "tok"), null);
  assert.deepEqual(proxyIdentity({ headers: { "x-facet-token": "tok", "x-facet-user": forwarded } }, "tok"), user);

  // Garbage payloads fail closed.
  const junk = Buffer.from("not json").toString("base64url");
  assert.equal(proxyIdentity({ headers: { "x-facet-token": "tok", "x-facet-user": junk } }, "tok"), null);
  const noEmail = Buffer.from(JSON.stringify({ groups: [] })).toString("base64url");
  assert.equal(proxyIdentity({ headers: { "x-facet-token": "tok", "x-facet-user": noEmail } }, "tok"), null);

  // An un-armed channel (no token configured) is closed even for matching headers.
  assert.equal(proxyIdentity({ headers: { "x-facet-token": "tok", "x-facet-user": forwarded } }, ""), null);

  // The composite resolver prefers the proxy channel and falls to session auth.
  const resolve = createResolveUser({
    expectedToken: "tok",
    sessionAuth: (req) => (req.headers.cookie === "s=1" ? { email: "s@x", groups: [] } : null),
  });
  assert.equal(resolve({ headers: { cookie: "s=1" } }).email, "s@x");
  assert.equal(resolve({ headers: { "x-facet-token": "tok", "x-facet-user": forwarded } }).email, "u@x");
  assert.equal(resolve({ headers: {} }), null);
});

// ── 2.5 壹座 embedded-facet proxy ────────────────────────────────────────────

test("2.5 facet proxy: forwards method/body with identity stamp; 502 when facet is down", async () => {
  const seen = [];
  const app = express();
  registerFacetProxy(app, {
    base: "https://facet.internal",
    resolveUser: (req) => (req.headers.authorization === "Bearer u1" ? { email: "u@x", groups: ["g1"] } : null),
    token: "tok",
    fetchImpl: async (url, init = {}) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, echo: init.body ? Buffer.from(init.body).toString("utf8") : null }), {
        status: url.endsWith("/api/packs") && init.method === "POST" ? 201 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Anonymous browse: forwarded WITHOUT identity headers.
    const get = await fetch(`${base}/api/packs?tag=t1`);
    assert.equal(get.status, 200);
    assert.equal(seen[0].url, "https://facet.internal/api/packs?tag=t1");
    assert.equal(seen[0].init.headers["x-facet-user"], undefined);

    // Authenticated publish: identity + credential stamped, body passes.
    const post = await fetch(`${base}/api/packs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u1" },
      body: JSON.stringify({ manifest: MANIFEST() }),
    });
    assert.equal(post.status, 201);
    assert.equal(seen[1].init.method, "POST");
    assert.equal(seen[1].init.headers["x-facet-token"], "tok");
    // Service credentials ride verbatim (the runner's internal-route path).
    assert.equal(seen[1].init.headers.Authorization, "Bearer u1");
    const stamped = JSON.parse(Buffer.from(seen[1].init.headers["x-facet-user"], "base64url").toString("utf8"));
    assert.equal(stamped.email, "u@x");
    assert.deepEqual(stamped.groups, ["g1"]);
    const echoed = await post.json();
    assert.equal(JSON.parse(echoed.echo).manifest.name, "Pub");

    // Deep path forwards whole prefix.
    await fetch(`${base}/api/packs/someid/versions/1`);
    assert.equal(seen[2].url, "https://facet.internal/api/packs/someid/versions/1");
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Facet unreachable → 502 with reason, not a hang.
  const down = express();
  registerFacetProxy(down, { base: "http://127.0.0.1:9", resolveUser: () => null, token: "", fetchImpl: fetch });
  const downServer = http.createServer(down).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${downServer.address().port}/api/packs`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /unreachable/);
  } finally {
    await new Promise((r) => downServer.close(r));
  }
});

// ── S2.1 MCP catalog cards ───────────────────────────────────────────────────

test("S2 mcp-catalog: anonymous sees group-less servers only; grouped visible to members; shape is card-ready", async () => {
  const { registerFacetMcpRoutes } = await import("../facet/mcp-catalog.js");
  const entries = [
    { name: "websearch", displayName: "Web Search", description: "search", configTemplate: { url: "https://mcp.x/websearch/mcp" }, groups: [] },
    { name: "law-bench", displayName: "LawBench", description: "legal", configTemplate: { url: "https://mcp.x/law-bench/mcp" }, groups: ["legal", "org123"] },
  ];
  const app = express();
  registerFacetMcpRoutes(app, {
    resolveUser: (req) => (req.headers["x-viewer"] ? { email: "u@x", groups: String(req.headers["x-viewer"]).split(",") } : null),
    entriesFn: () => entries,
  });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await (await fetch(`${base}/api/mcp-catalog`)).json();
    assert.equal(anon.servers.length, 1);
    assert.equal(anon.servers[0].name, "websearch");
    assert.equal(anon.servers[0].endpoint, "https://mcp.x/websearch/mcp");
    assert.deepEqual(anon.servers[0].requiredGroups, []);

    const member = await (await fetch(`${base}/api/mcp-catalog`, { headers: { "x-viewer": "org123" } })).json();
    assert.equal(member.servers.length, 2);
    const law = member.servers.find((s) => s.name === "law-bench");
    assert.equal(law.displayName, "LawBench");
    assert.deepEqual(law.requiredGroups, ["legal", "org123"]);

    // A logged-in user without the group stays in the anonymous view.
    const outsider = await (await fetch(`${base}/api/mcp-catalog`, { headers: { "x-viewer": "other-org" } })).json();
    assert.equal(outsider.servers.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── add-facet-infra-pages: depth view + skills catalog ──────────────────────

test("mcp depth route carries tools/provenance on demand; visibility gated; card list stays six fields", async () => {
  const { registerFacetMcpRoutes } = await import("../facet/mcp-catalog.js");
  const entries = [
    {
      name: "websearch",
      displayName: "Web Search",
      description: "search",
      configTemplate: { url: "https://mcp.x/websearch/mcp" },
      groups: [],
      toolDetails: [
        { name: "search", description: "Search the web." },
        { name: "fetch", description: "Fetch a page." },
      ],
      toolList: ["search", "fetch"],
      numTools: 2,
      license: "MIT",
      providerOrganization: "example-org",
      deployment: "remote",
      tags: ["ecosystem", "official"],
    },
    {
      name: "bare-server",
      displayName: "Bare",
      description: "no metadata declared",
      configTemplate: { url: "https://mcp.x/bare/mcp" },
      groups: [],
    },
    {
      name: "law-bench",
      displayName: "LawBench",
      description: "legal",
      configTemplate: { url: "https://mcp.x/law-bench/mcp" },
      groups: ["legal"],
      toolDetails: [{ name: "review", description: "Review a contract." }],
    },
  ];
  const app = express();
  registerFacetMcpRoutes(app, {
    resolveUser: (req) => (req.headers["x-viewer"] ? { email: "u@x", groups: String(req.headers["x-viewer"]).split(",") } : null),
    entriesFn: () => entries,
  });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // The card list stays five fields — no tool surface rides the default payload.
    const list = await (await fetch(`${base}/api/mcp-catalog`)).json();
    assert.deepEqual(
      Object.keys(list.servers[0]).sort(),
      ["description", "displayName", "endpoint", "name", "requiredGroups"].sort(),
    );
    assert.equal(list.servers[0].tools, undefined);

    // Depth: tools + provenance as declared.
    const depth = await (await fetch(`${base}/api/mcp-catalog/websearch`)).json();
    assert.deepEqual(depth.tools, [
      { name: "search", description: "Search the web." },
      { name: "fetch", description: "Fetch a page." },
    ]);
    assert.equal(depth.toolCount, 2);
    assert.equal(depth.license, "MIT");
    assert.equal(depth.providerOrganization, "example-org");
    assert.equal(depth.deployment, "remote");
    assert.deepEqual(depth.tags, ["ecosystem", "official"]);

    // Absent fields render null (honest rendering) — never invented.
    const bare = await (await fetch(`${base}/api/mcp-catalog/bare-server`)).json();
    assert.equal(bare.tools, null);
    assert.equal(bare.license, null);
    assert.equal(bare.providerOrganization, null);
    assert.equal(bare.deployment, null);

    // Group-gated entry: not-found for the anonymous caller, visible to a member.
    assert.equal((await fetch(`${base}/api/mcp-catalog/law-bench`)).status, 404);
    const member = await fetch(`${base}/api/mcp-catalog/law-bench`, { headers: { "x-viewer": "legal" } });
    assert.equal(member.status, 200);
    assert.equal((await member.json()).tools[0].name, "review");

    // Unknown name: not-found.
    assert.equal((await fetch(`${base}/api/mcp-catalog/nope`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("skills catalog: provenance marks, visibility gating, read-only", async () => {
  const { registerFacetMcpRoutes } = await import("../facet/mcp-catalog.js");
  const skills = [
    {
      name: "legal-harness-init",
      displayName: "legal-harness-init",
      description: "legal skill",
      repositoryUrl: "https://github.com/cat-xierluo/legal-skills",
      author: "杨卫薪",
      version: "1.0.0",
      tags: ["legal", "chinese-law"],
      groups: [],
    },
    {
      name: "finddata-internal",
      displayName: "internal",
      description: "grouped",
      repositoryUrl: null,
      author: null,
      version: null,
      tags: [],
      groups: ["analysts"],
    },
  ];
  const app = express();
  registerFacetMcpRoutes(app, {
    resolveUser: (req) => (req.headers["x-viewer"] ? { email: "u@x", groups: String(req.headers["x-viewer"]).split(",") } : null),
    entriesFn: () => [],
    skillsFn: () => skills,
  });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await (await fetch(`${base}/api/skills-catalog`)).json();
    assert.equal(anon.skills.length, 1);
    const sk = anon.skills[0];
    assert.equal(sk.name, "legal-harness-init");
    assert.equal(sk.repositoryUrl, "https://github.com/cat-xierluo/legal-skills");
    assert.equal(sk.author, "杨卫薪");
    assert.deepEqual(sk.tags, ["legal", "chinese-law"]);

    const member = await (await fetch(`${base}/api/skills-catalog`, { headers: { "x-viewer": "analysts" } })).json();
    assert.equal(member.skills.length, 2);
    const grouped = member.skills.find((s) => s.name === "finddata-internal");
    // Undeclared provenance stays null (renders "not declared").
    assert.equal(grouped.repositoryUrl, null);
    assert.equal(grouped.author, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── agent-service-config: the proxy's actor-header pass-through ──────────────

test("2.5 facet proxy forwards the config channel's actor headers (agent-service-config)", async () => {
  const { facetForwardHeaders } = await import("../gateway/facet-proxy.js");
  // The actor pair rides when present, is omitted when absent (inert without
  // the internal credential — trust is transitive).
  const h = facetForwardHeaders({ token: "t", actingUser: "u@x", actingGroups: "creators,admin" });
  assert.equal(h["x-acting-user"], "u@x");
  assert.equal(h["x-acting-groups"], "creators,admin");
  assert.equal(facetForwardHeaders({ token: "t" })["x-acting-user"], undefined);
  // End-to-end through the registered proxy: the upstream (facet stand-in)
  // sees the headers, and the service credential rides alongside.
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = { actor: req.headers["x-acting-user"], groups: req.headers["x-acting-groups"], auth: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const app = express();
  registerFacetProxy(app, {
    base: `http://127.0.0.1:${upstream.address().port}`,
    resolveUser: () => null,
    token: "facet-tok",
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/packs/internal/deployments/P1/a1/config`, {
      headers: { Authorization: "Bearer svc", "x-acting-user": "deployer@x", "x-acting-groups": "creators" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { actor: "deployer@x", groups: "creators", auth: "Bearer svc" });
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});
