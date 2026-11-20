// Unit tests for registry-bridge.js + extension-store market merge
// (registry-backed-market change, tasks 2.1/2.2/4.1):
//   - server/skill/agent mapping from the pinned registry response shapes
//   - disabled/URL-less entries dropped; agents without url dropped
//   - last-good snapshot kept when the registry starts failing
//   - market_changed broadcast on change, silence on unchanged refresh
//   - single-flight: overlapping refreshes share one fetch round
//   - getSkillContent endpoint transform + content extraction
//   - market assembly (add-supply-catalog-unification): the catalog source is
//     the single truth (offline snapshot ignored when a source is configured);
//     the app-shipped starter floor is appended, catalog wins on collision;
//     requiresConfig covers header placeholders; group visibility
//     (member / non-member / auth off)
//
// The registry URL env is set before the dynamic imports (module-scope
// constants read it); fetch is injected via initRegistryBridge({fetchImpl}).

process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "test-token";
delete process.env.REGISTRY_URL;
// Redirect bundled catalogs + the groups mapping to a temp dir. Must happen
// before the dynamic imports below (they resolve these paths at module load).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "registry-bridge-")));

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bridge = await import("../registry-bridge.js");
const extensionStore = await import("../extension-store.js");

// Distinct marker so each test's first fill differs from the previous
// snapshot (module-level signature is shared across tests in this process).
let marker = "v1";

// List endpoints are paginated: the live registry defaults to limit=20 and
// signals continuation via has_next. Stubs key on the bare PATH and are
// sliced here so a multi-page read is exercised end to end.
//
// PAGE_CAP models a server that clamps the requested limit (the live default
// is 20). A client must not assume its `limit` is honored — that assumption
// is the defect these tests pin.
const PAGE_CAP = 20;
function itemsOf(doc) {
  if (Array.isArray(doc)) return doc;
  return doc.servers ?? doc.skills ?? doc.agents ?? doc.items ?? [];
}
function listKeyOf(doc, path = "") {
  if (Array.isArray(doc)) return path === "/api/agents" ? "agents" : null;
  for (const k of ["servers", "skills", "agents", "items"]) if (Array.isArray(doc[k])) return k;
  return null;
}
function goodResponses() {
  return {
    "/api/servers": {
      servers: [
        {
          path: "/currenttime",
          display_name: "Current Time",
          description: `Time server ${marker}`,
          is_enabled: true,
          health_status: "healthy",
          status: "active",
        },
        {
          path: "/disabled-one",
          display_name: "Disabled",
          description: "off",
          is_enabled: false,
          health_status: "unknown",
          status: "active",
        },
        {
          // Live-probed shape: list entries carry an (often null) mcp_endpoint.
          // standardize-mcp-public-endpoints: the endpoint fields are upstream
          // addressing — even a populated one must NOT become the consumer URL;
          // mapServer derives {REGISTRY_URL}/{path}/mcp unconditionally.
          path: "/explicit-endpoint",
          display_name: "Explicit",
          description: "declares its own endpoint",
          is_enabled: true,
          tags: ["Data"],
          mcp_endpoint: "https://elsewhere.example/custom",
          proxy_pass_url: "http://cheap6.mesh.finddata.cn:31893/mcp",
          // Depth-view fields (add-facet-infra-pages): the live shape carries
          // license/provider_organization/tool_list (objects with descriptions).
          license: "MIT",
          provider_organization: "modelcontextprotocol",
          num_tools: 2,
          tool_list: [
            { name: "get_time", description: "Returns the current time." },
            { name: "set_zone", description: "Sets the timezone." },
          ],
        },
      ],
      total_count: 2,
    },
    "/api/skills": {
      skills: [
        {
          id: "s1",
          name: "PDF Processing",
          path: "/skills/pdf-processing",
          description: "Process PDFs",
          skill_md_url: "https://x/SKILL.md",
          is_enabled: true,
          tags: ["docs"],
          // Provenance (add-facet-infra-pages): declared on the live shape.
          repository_url: "https://github.com/example/pdf-skills",
          author: "Example Author",
          version: "1.2.0",
        },
      ],
      total_count: 1,
    },
    "/api/agents": [
      {
        name: "Weather",
        path: "/agents/weather",
        url: "https://registry.example.test/agent/weather",
        num_skills: 2,
        is_enabled: true,
        status: "active",
        supportedProtocol: "a2a",
      },
      { name: "NoUrl", path: "/agents/nourl", is_enabled: true },
    ],
    "/api/skills/pdf-processing/content": {
      content: "---\nname: x\ndescription: y\n---\n\nBODY",
      url: "u",
    },
  };
}

function makeFetch(responsesFn) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers });
    const doc = responsesFn();
    const endpoint = url.replace(/^https:\/\/registry\.example\.test/, "");
    const [rawPath, rawQuery = ""] = endpoint.split("?");
    const body = doc[rawPath];
    if (!body) throw new Error(`unexpected endpoint ${endpoint}`);
    // Paginate list responses the way the live registry does: clamp the
    // requested limit, slice by offset, carry the envelope.
    const key = listKeyOf(body, rawPath);
    if (!key) return { ok: true, status: 200, json: async () => body };
    const q = new URLSearchParams(rawQuery);
    const all = itemsOf(body);
    const limit = Math.min(Number(q.get("limit") ?? PAGE_CAP), PAGE_CAP);
    const offset = Number(q.get("offset") ?? 0);
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        [key]: page,
        total_count: all.length,
        limit,
        offset,
        has_next: nextOffset < all.length,
      }),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("mapping: servers/skills/agents → market + catalog shapes", async () => {
  const events = [];
  const fetchImpl = makeFetch(goodResponses);
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl });
  await bridge.refreshRegistry();

  const market = bridge.getMarketEntries();
  assert.equal(market.mcpServers.length, 2, "disabled server dropped");
  const srv = market.mcpServers[0];
  assert.equal(srv.name, "currenttime");
  assert.equal(srv.displayName, "Current Time");
  assert.equal(srv.configTemplate.url, "https://registry.example.test/currenttime/mcp");
  assert.equal(srv.configTemplate.headers.Authorization, "Bearer <your_token>");
  assert.equal(srv.origin, "registry");
  assert.deepEqual(srv.groups, []);

  const explicit = market.mcpServers[1];
  assert.equal(explicit.name, "explicit-endpoint");
  // standardize-mcp-public-endpoints: gateway URL only — the registry's
  // mcp_endpoint/proxy_pass_url never reach the consumer surface.
  assert.equal(
    explicit.configTemplate.url,
    "https://registry.example.test/explicit-endpoint/mcp",
  );
  assert.equal(explicit.category, "Data");
  // Depth-view fields (add-facet-infra-pages): provenance + tool details ride
  // the snapshot; names-only toolList stays the pack editor's contract.
  assert.deepEqual(explicit.toolList, ["get_time", "set_zone"]);
  assert.deepEqual(explicit.toolDetails, [
    { name: "get_time", description: "Returns the current time." },
    { name: "set_zone", description: "Sets the timezone." },
  ]);
  assert.equal(explicit.license, "MIT");
  assert.equal(explicit.providerOrganization, "modelcontextprotocol");
  assert.equal(explicit.numTools, 2);
  assert.deepEqual(explicit.tags, ["Data"]);
  // Absent fields stay absent — never invented (the honest-rendering contract).
  assert.equal(srv.license, null);
  assert.equal(srv.providerOrganization, null);
  assert.equal(srv.toolDetails, null);
  assert.deepEqual(srv.tags, []);

  assert.equal(market.skills.length, 1);
  assert.equal(market.skills[0].name, "pdf-processing");
  assert.equal(market.skills[0].contentPath, "/skills/pdf-processing");
  assert.equal(market.skills[0].category, "docs");
  assert.equal(market.skills[0].skillTemplate, undefined, "no inline content for registry skills");
  // Provenance (add-facet-infra-pages; openspec: ecosystem-curation).
  assert.equal(market.skills[0].repositoryUrl, "https://github.com/example/pdf-skills");
  assert.equal(market.skills[0].author, "Example Author");
  assert.equal(market.skills[0].version, "1.2.0");
  assert.deepEqual(market.skills[0].tags, ["docs"]);

  const agents = bridge.getAgentEntries();
  assert.equal(agents.length, 1, "url-less agent dropped");
  assert.equal(agents[0].id, "registry-agents-weather");
  assert.equal(agents[0].mode, "a2a", "supported_protocol a2a maps to a2a mode");
  assert.match(agents[0].url, /\/agent\/agents\/weather\/$/, "url is the gateway route, not the entry backend url");
  assert.equal(agents[0].type, "agent-remote");
  assert.equal(agents[0].url.endsWith("/agent/agents/weather/"), true, "a2a agent url is the gateway route");

  assert.equal(fetchImpl.calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(events.filter((e) => e.type === "market_changed").length, 1, "first fill broadcasts");
});

// ── group carry-through (carry-registry-visibility-through-bridge 3.4) ───────
// Carried {visibility, allowed_groups} metadata wins over the hand-mapped
// registry-groups.json; a group-restricted entry NEVER degrades to public —
// empty groups map to the never-matchable sentinel (fail-closed), and the
// pre-upgrade compat window (no visibility field) stays byte-identical to the
// hand-mapping behavior.

test("groups: carried metadata wins over hand mapping; fail-closed on empty restricted", async () => {
  marker = "c2-groups";
  // Hand mapping says one thing for every entry — carried metadata must win
  // wherever it exists, and the mapping must only bite in the compat window.
  fs.writeFileSync(
    path.join(process.cwd(), "registry-groups.json"),
    JSON.stringify({
      servers: {
        "carried-public": ["legacy-group"],
        "carried-restricted": ["legacy-group"],
        "carried-empty-restricted": ["legacy-group"],
        "compat-window": ["mapped-group"],
      },
    }),
  );
  const fetchImpl = makeFetch(() => ({
    "/api/servers": {
      servers: [
        {
          path: "/carried-public",
          display_name: "Carried Public",
          description: "official default-visible",
          is_enabled: true,
          // Hand mapping registered a group, but the truth says public.
          visibility: "public",
        },
        {
          path: "/carried-restricted",
          display_name: "Carried Restricted",
          description: "per-customer cell",
          is_enabled: true,
          visibility: "group-restricted",
          allowed_groups: ["wire-cust-acme"],
        },
        {
          path: "/carried-empty-restricted",
          display_name: "Restricted No Groups",
          description: "invariant-violating residue",
          is_enabled: true,
          visibility: "group-restricted",
          allowed_groups: [],
        },
        {
          path: "/compat-window",
          display_name: "Pre-upgrade Row",
          description: "no visibility field — hand mapping applies",
          is_enabled: true,
        },
      ],
      total_count: 4,
    },
    "/api/skills": { skills: [], total_count: 0 },
    "/api/agents": { agents: [], total_count: 0 },
  }));
  bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
  await bridge.refreshRegistry();

  const byName = Object.fromEntries(
    bridge.getMarketEntries().mcpServers.map((s) => [s.name, s]),
  );

  // Metadata beats the hand mapping in both directions.
  assert.deepEqual(
    byName["carried-public"].groups, [],
    "carried public wins over a mapped group (empty = public)",
  );
  assert.deepEqual(
    byName["carried-restricted"].groups, ["wire-cust-acme"],
    "carried groups pass through verbatim",
  );
  // Fail-closed: restricted with no groups maps to the never-matchable
  // sentinel, never to [] (=public).
  assert.deepEqual(
    byName["carried-empty-restricted"].groups, ["__restricted_ungrouped__"],
    "restricted without groups is fail-closed, not public",
  );
  // Compat window: no metadata → hand mapping, byte-identical to pre-change.
  assert.deepEqual(
    byName["compat-window"].groups, ["mapped-group"],
    "pre-upgrade rows keep the hand-mapped behavior",
  );
  fs.rmSync(path.join(process.cwd(), "registry-groups.json"));
});

// ── pagination completeness (registry-list-completeness) ─────────────────────
// The live registry paginates list endpoints (default limit=20) and reports
// total_count/has_next. Reading one page as "everything" silently drops
// entries — production hit this on /api/agents (23 entries, 20 returned).

test("pagination: every entry is read when the registry spans several pages", async () => {
  // 25 agents: more than the default page, fewer than one limit=500 page. The
  // stub slices at the requested limit, so a single-read implementation can
  // only ever see the first 20.
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: `agent-${i}`,
    path: `/agents/agent-${i}`,
    url: `https://registry.example.test/agent/agent-${i}`,
    is_enabled: true,
    supported_protocol: "a2a",
  }));
  const fetchImpl = makeFetch(() => ({
    "/api/servers": { servers: [{ path: "/srv", display_name: "S", is_enabled: true }] },
    "/api/skills": { skills: [{ name: "sk", path: "/skills/sk", is_enabled: true }] },
    "/api/agents": many,
  }));
  bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
  await bridge.refreshRegistry();

  const agents = bridge.getAgentEntries();
  assert.equal(agents.length, 25, "all 25 agents read, not the first page only");
  assert.ok(agents.some((a) => a.id === "registry-agents-agent-24"), "the last entry survives");
});

test("pagination: offset advances so pages do not repeat", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `s-${i}`,
    path: `/servers/s-${i}`,
    is_enabled: true,
  }));
  const fetchImpl = makeFetch(() => ({
    "/api/servers": { servers: many },
    "/api/skills": { skills: [{ name: "sk", path: "/skills/sk", is_enabled: true }] },
    "/api/agents": [{ name: "a", path: "/agents/a", is_enabled: true }],
  }));
  bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
  await bridge.refreshRegistry();

  const servers = bridge.getMarketEntries().mcpServers;
  assert.equal(servers.length, 60);
  assert.equal(new Set(servers.map((s) => s.name)).size, 60, "no duplicates from a stuck offset");
});

test("pagination: a truncated read is logged with endpoint and counts", async () => {
  // has_next stays true forever: the read cannot complete. The bridge must
  // still use what it got (partial success beats an empty market) and say so.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    const fetchImpl = async (url) => {
      const endpoint = url.replace(/^https:\/\/registry\.example\.test/, "");
      const path = endpoint.split("?")[0];
      const base = {
        "/api/servers": { servers: [{ path: "/srv", display_name: "S", is_enabled: true }] },
        "/api/skills": { skills: [{ name: "sk", path: "/skills/sk", is_enabled: true }] },
        "/api/agents": [
          { name: "a", path: "/agents/a", url: "https://registry.example.test/agent/a", is_enabled: true },
        ],
      }[path];
      if (!base) throw new Error(`unexpected endpoint ${endpoint}`);
      const key = listKeyOf(base, path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          [key]: itemsOf(base),
          total_count: 99,
          limit: 20,
          offset: 0,
          has_next: true, // never resolves
        }),
      };
    };
    bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
    await bridge.refreshRegistry();

    const msg = warns.join("\n");
    assert.match(msg, /truncated/i, "a truncated read must be reported");
    assert.match(msg, /\/api\/(servers|skills|agents)/, "the warning names the endpoint");
    assert.match(msg, /99/, "the warning carries total_count");
    assert.ok(bridge.getAgentEntries().length > 0, "partial data is still used");
  } finally {
    console.warn = origWarn;
  }
});

test("last-good: failing refresh keeps the snapshot; unchanged refresh stays silent", async () => {
  const events = [];
  let failing = false;
  marker = "v2"; // differs from test 1 → the first fill here broadcasts
  const fetchImpl = makeFetch(() => {
    if (failing) throw new Error("down");
    return goodResponses();
  });
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl });
  await bridge.refreshRegistry();
  const before = JSON.stringify(bridge.getMarketEntries());

  failing = true;
  await bridge.refreshRegistry();
  assert.equal(JSON.stringify(bridge.getMarketEntries()), before, "last-good kept");

  failing = false;
  await bridge.refreshRegistry();
  assert.equal(
    events.filter((e) => e.type === "market_changed").length,
    1,
    "identical refresh does not re-broadcast",
  );
});

test("single-flight: concurrent refreshes share one fetch round", async () => {
  marker = "v3";
  const fetchImpl = makeFetch(goodResponses);
  bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
  await Promise.all([
    bridge.refreshRegistry(),
    bridge.refreshRegistry(),
    bridge.refreshRegistry(),
  ]);
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/api/servers")).length, 1);
});

test("getSkillContent: /skills prefix stripped, content extracted", async () => {
  const fetchImpl = makeFetch(goodResponses);
  bridge.initRegistryBridge({ broadcast: () => {}, fetchImpl });
  const content = await bridge.getSkillContent("/skills/pdf-processing");
  assert.match(content, /^---/);
  assert.match(content, /BODY$/);
  await assert.rejects(() => bridge.getSkillContent("/skills/missing"), /unexpected endpoint/);
});

// ── market merge + visibility (extension-store.getMarketCatalog) ────────────

test("market assembly: catalog source wins, starter floor appended, snapshot ignored; requiresConfig; groups filter", async () => {
  marker = "v4";
  // The starter floor (app-shipped stdio) — appended beside the catalog.
  fs.writeFileSync(
    path.join(process.cwd(), "market-starters.json"),
    JSON.stringify({
      mcpServers: [
        {
          // Collides with the registry entry of the same name: the CATALOG
          // (registry) wins — the supply plane is the truth for what a server
          // is; the starter is only a floor.
          name: "currenttime",
          displayName: "Starter CurrentTime",
          description: "starter",
          category: "Productivity",
          icon: "clock",
          configTemplate: { command: "npx", args: ["-y", "server-time"] },
        },
        {
          name: "static-url",
          displayName: "Static URL",
          description: "no placeholders",
          category: "X",
          icon: "box",
          configTemplate: { url: "https://a.example/mcp", headers: { "X-Static": "v" } },
        },
        {
          name: "gateway-style",
          displayName: "Gateway Style",
          description: "token placeholder header",
          category: "X",
          icon: "box",
          configTemplate: { url: "https://g.example/mcp", headers: { Authorization: "Bearer <your_token>" } },
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(process.cwd(), "market-starters-skills.json"),
    JSON.stringify({ skills: [] }),
  );
  // The generated offline snapshot must NOT participate while a catalog
  // source is configured — its sentinel entry proves the single-source rule.
  fs.writeFileSync(
    path.join(process.cwd(), "market-catalog.json"),
    JSON.stringify({ _meta: { as_of: "2026-01-01T00:00:00Z", source: "supply-catalog" }, mcpServers: [{ name: "snapshot-only", displayName: "Snapshot", description: "s", icon: "box", configTemplate: { url: "https://s.example/mcp" } }] }),
  );
  fs.writeFileSync(
    path.join(process.cwd(), "market-catalog-skills.json"),
    JSON.stringify({ _meta: { as_of: "2026-01-01T00:00:00Z", source: "supply-catalog" }, skills: [] }),
  );
  fs.writeFileSync(
    path.join(process.cwd(), "registry-groups.json"),
    JSON.stringify({ skills: { "pdf-processing": ["team-a"] } }),
  );

  await bridge.refreshRegistry();
  extensionStore.clearMarketCatalogCache();

  const anon = await extensionStore.getMarketCatalog(null);

  // Catalog (registry) wins the collision over the starter floor.
  const ct = anon.mcpServers.find((s) => s.name === "currenttime");
  assert.equal(ct.displayName, "Current Time", "registry entry wins over the starter of the same name");

  // The offline snapshot is ignored while a source is configured.
  assert.equal(anon.mcpServers.some((s) => s.name === "snapshot-only"), false, "snapshot file does not merge when a source is active");

  // Starter floor appended; header placeholder ⇒ needs config; static does not.
  assert.ok(anon.mcpServers.some((s) => s.name === "static-url"), "starter floor appended");
  assert.equal(anon.mcpServers.find((s) => s.name === "gateway-style")?.requiresConfig, true);
  assert.equal(anon.mcpServers.find((s) => s.name === "static-url")?.requiresConfig, false);

  // The registry skill is gated but auth off means the machine owner, who
  // sees everything.
  assert.ok(anon.skills.some((s) => s.name === "pdf-processing"), "gated skill visible when auth off (machine owner)");

  const member = await extensionStore.getMarketCatalog({ email: "a@b.c", groups: ["team-a"] });
  assert.ok(member.skills.some((s) => s.name === "pdf-processing"), "member sees gated skill");

  const outsider = await extensionStore.getMarketCatalog({ email: "x@y.z", groups: ["team-b"] });
  assert.equal(outsider.skills.some((s) => s.name === "pdf-processing"), false, "non-member does not");
});

// ── agent catalog third source (catalog.js) ─────────────────────────────────

test("catalog: agents.json beats registry on collision; registry roles gate visibility", async () => {
  marker = "v5";
  // 1) Collision: local agents.json overrides the registry agent.
  fs.writeFileSync(
    path.join(process.cwd(), "agents.json"),
    JSON.stringify({
      agents: [
        {
          id: "registry-agents-weather",
          type: "agent-remote",
          mode: "link",
          name: "Local Weather Override",
          url: "https://local.example/weather",
        },
      ],
      apps: [],
    }),
  );
  fs.writeFileSync(path.join(process.cwd(), "registry-groups.json"), JSON.stringify({}));
  await bridge.refreshRegistry();
  const catalogMod = await import("../catalog.js");
  await catalogMod.refresh(null);
  const weather = catalogMod.getCatalogFor(null).agents.find((a) => a.id === "registry-agents-weather");
  assert.equal(weather?.name, "Local Weather Override", "local file wins over registry");

  // 2) Role gating: without the local override, the registry agent's registry
  //    groups map to roles and gate visibility.
  fs.rmSync(path.join(process.cwd(), "agents.json"));
  fs.writeFileSync(
    path.join(process.cwd(), "registry-groups.json"),
    JSON.stringify({ agents: { "agents-weather": ["team-a"] } }),
  );
  await bridge.refreshRegistry();
  await catalogMod.refresh(null);
  assert.ok(
    catalogMod.getCatalogFor(null).agents.some((a) => a.id === "registry-agents-weather"),
    "gated agent visible when auth off (machine owner)",
  );
  assert.equal(
    catalogMod.getCatalogFor({ email: "x@y.z", groups: ["team-b"] }).agents.some((a) => a.id === "registry-agents-weather"),
    false,
    "gated agent hidden from non-members",
  );
  assert.ok(
    catalogMod.getCatalogFor({ email: "a@b.c", groups: ["team-a"] }).agents.some((a) => a.id === "registry-agents-weather"),
    "member sees the gated agent",
  );

  // 3) Role-less registry agents are visible to everyone.
  fs.writeFileSync(path.join(process.cwd(), "registry-groups.json"), JSON.stringify({}));
  await bridge.refreshRegistry();
  await catalogMod.refresh(null);
  assert.ok(
    catalogMod.getCatalogFor(null).agents.some((a) => a.id === "registry-agents-weather"),
    "role-less agent visible with auth off",
  );
});

// ── standardize-mcp-public-endpoints: consumer-endpoint guard ────────────────

test("endpoint guard: internal-form URLs blocked at the assembly exit", () => {
  const cases = [
    "http://cheap6.mesh.finddata.cn:31893/mcp",
    "https://CHEAP6.MESH.FINDDATA.CN:31893/mcp",
    "http://sub.mesh.finddata.cn/mcp",
    "http://10.255.254.77:8090/mcp",
    "http://100.127.0.1/mcp",
    "http://10.1.2.3:8000/mcp",
    "http://192.168.1.5/mcp",
    "http://172.16.0.9/mcp",
    "http://172.31.255.1/mcp",
    "http://127.0.0.1:7860/mcp",
    "http://localhost:8003/mcp",
  ];
  for (const bad of cases) {
    assert.equal(
      bridge.isInternalFormUrl(bad),
      true,
      `expected internal-form: ${bad}`,
    );
    assert.equal(
      bridge.consumerEndpointFor("some-server", bad),
      "https://registry.example.test/some-server/mcp",
      `guard must derive gateway URL for: ${bad}`,
    );
  }
});

test("endpoint guard: public URLs pass through; falsy falls back to derived", () => {
  assert.equal(bridge.isInternalFormUrl("https://mcp.vendor.example/mcp"), false);
  assert.equal(
    bridge.consumerEndpointFor("some-server", "https://mcp.vendor.example/mcp"),
    "https://mcp.vendor.example/mcp",
  );
  assert.equal(
    bridge.consumerEndpointFor("some-server", ""),
    "https://registry.example.test/some-server/mcp",
  );
  assert.equal(
    bridge.consumerEndpointFor("some-server", null),
    "https://registry.example.test/some-server/mcp",
  );
});
