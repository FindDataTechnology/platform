// Unit tests for registry-bridge.js + extension-store market merge
// (registry-backed-market change, tasks 2.1/2.2/4.1):
//   - server/skill/agent mapping from the pinned registry response shapes
//   - disabled/URL-less entries dropped; agents without url dropped
//   - last-good snapshot kept when the registry starts failing
//   - market_changed broadcast on change, silence on unchanged refresh
//   - single-flight: overlapping refreshes share one fetch round
//   - getSkillContent endpoint transform + content extraction
//   - market merge: bundled wins on name collision; requiresConfig covers
//     header placeholders; group visibility (member / non-member / auth off)
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
function goodResponses() {
  return {
    "/api/servers?limit=500": {
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
          // Live-probed shape: list entries carry an (often null) mcp_endpoint
          // plus tags; an explicit endpoint must win over the derived URL.
          path: "/explicit-endpoint",
          display_name: "Explicit",
          description: "declares its own endpoint",
          is_enabled: true,
          tags: ["Data"],
          mcp_endpoint: "https://elsewhere.example/custom",
        },
      ],
      total_count: 2,
    },
    "/api/skills?limit=500": {
      skills: [
        {
          id: "s1",
          name: "PDF Processing",
          path: "/skills/pdf-processing",
          description: "Process PDFs",
          skill_md_url: "https://x/SKILL.md",
          is_enabled: true,
          tags: ["docs"],
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
    const body = doc[endpoint];
    if (!body) throw new Error(`unexpected endpoint ${endpoint}`);
    return { ok: true, status: 200, json: async () => body };
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
  assert.equal(explicit.configTemplate.url, "https://elsewhere.example/custom");
  assert.equal(explicit.category, "Data");

  assert.equal(market.skills.length, 1);
  assert.equal(market.skills[0].name, "pdf-processing");
  assert.equal(market.skills[0].contentPath, "/skills/pdf-processing");
  assert.equal(market.skills[0].category, "docs");
  assert.equal(market.skills[0].skillTemplate, undefined, "no inline content for registry skills");

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

test("market merge: bundled wins collision; header placeholders require config; groups filter", async () => {
  marker = "v4";
  // Bundled "currenttime" collides with the registry entry of the same name.
  fs.writeFileSync(
    path.join(process.cwd(), "market-catalog.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "currenttime",
          displayName: "Bundled CurrentTime",
          description: "bundled",
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
    path.join(process.cwd(), "market-catalog-skills.json"),
    JSON.stringify({ skills: [] }),
  );
  fs.writeFileSync(
    path.join(process.cwd(), "registry-groups.json"),
    JSON.stringify({ skills: { "pdf-processing": ["team-a"] } }),
  );

  await bridge.refreshRegistry();
  extensionStore.clearMarketCatalogCache();

  const anon = await extensionStore.getMarketCatalog(null);

  // Bundled currenttime wins over the registry entry of the same name.
  const ct = anon.mcpServers.find((s) => s.name === "currenttime");
  assert.equal(ct.displayName, "Bundled CurrentTime");
  assert.equal(ct.requiresConfig, false, "command template without placeholders is ready-to-use");

  // Header placeholder ⇒ needs config; static headers do not.
  assert.equal(anon.mcpServers.find((s) => s.name === "gateway-style")?.requiresConfig, true);
  assert.equal(anon.mcpServers.find((s) => s.name === "static-url")?.requiresConfig, false);

  // Bundled entries always visible; the registry skill is gated but auth off
  // means the machine owner, who sees everything.
  assert.ok(anon.mcpServers.some((s) => s.name === "static-url"));
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
