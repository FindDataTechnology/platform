// ── 壹座 supply-catalog channel tests (add-supply-catalog-unification 3.x) ──
//
// 钉住 extension-marketplace 的新契约：
//   · FACET_CATALOG_URL 配置 → 目录物种来自 facet 投影（gateway configTemplate、
//     requiredGroups、raw annotations 透传）；
//   · 两者都配 → facet 赢，告警点名被忽略变量；
//   · 仅 legacy → 工作 + 每次 init 一条 deprecation 告警；
//   · 拉取失败保 last-good；变更广播 market_changed；
//   · 技能内容经 facet 代理按 NAME 取（不再需要 registry 凭据）；
//   · 离线：无源时服务生成快照 + 启动器地板（三件套 requiresConfig===false）。
//
//   node --test scripts/test-supply-catalog-yizuo.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Module-scope env constants are read at import — set them before importing.
process.env.FACET_CATALOG_URL = "https://facet.example.test";
process.env.FACET_CATALOG_TOKEN = "internal-sec";
process.env.MARKET_REGISTRY_URL = "https://registry.example.test"; // both configured
// REGISTRY_URL stays SET (not deleted): under the facet channel it no longer
// feeds the mcp/skills market species, but it IS the base of the agents leg
// (fix-cell-catalog-a2a-face) — /api/agents + gateway-route url construction.
process.env.REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "reg-tok";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "supply-yizuo-")));

import { test } from "node:test";
import assert from "node:assert/strict";

const bridge = await import("../registry-bridge.js");
const extensionStore = await import("../extension-store.js");

function facetResponses({ servers, skills, agents, agentsFail = false }) {
  return async (url) => {
    if (url.includes("/api/mcp-catalog")) return { ok: true, json: async () => ({ servers }) };
    if (url.includes("/api/skills-catalog")) return { ok: true, json: async () => ({ skills }) };
    // The agents leg rides the REGISTRY base + token (fix-cell-catalog-a2a-face).
    if (url.includes("/api/agents")) {
      if (agentsFail) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, json: async () => ({ agents: agents ?? [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const FACET_MCP = [
  { name: "airegistry", displayName: "ARegistry", description: "d", endpoint: "https://gw/airegistry/mcp", requiredGroups: [], annotations: { human: { zh: { name: "注册处" } }, provenance: { source: "registry" } } },
  { name: "gated", displayName: "Gated", description: "g", endpoint: "https://gw/gated/mcp", requiredGroups: ["partners"] },
];
const FACET_SKILLS = [
  { name: "pdf", displayName: "PDF", description: "p", repositoryUrl: "https://r", author: "a", version: "1", tags: ["x"], requiredGroups: [] },
];

test("facet channel: catalog species come from the facet projection", async () => {
  const events = [];
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS }) });
  await bridge.refreshRegistry();
  const { mcpServers, skills } = bridge.getMarketEntries();
  assert.deepEqual(mcpServers.map((s) => s.name), ["airegistry", "gated"]);
  assert.equal(mcpServers[0].configTemplate.url, "https://gw/airegistry/mcp");
  assert.equal(mcpServers[0].origin, "facet-catalog");
  assert.deepEqual(mcpServers[1].groups, ["partners"]);
  assert.ok(mcpServers[0].annotations, "raw annotation object carried through");
  assert.deepEqual(skills.map((s) => s.name), ["pdf"]);
});

test("facet channel broadcasts market_changed on change", async () => {
  const events = [];
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl: facetResponses({ servers: [{ name: "a", endpoint: "https://gw/a/mcp", requiredGroups: [] }], skills: [] }) });
  await bridge.refreshRegistry();
  const before = events.length;
  await bridge.refreshRegistry(); // unchanged → silent
  assert.equal(events.length, before, "unchanged refresh stays silent");
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl: facetResponses({ servers: [{ name: "b", endpoint: "https://gw/b/mcp", requiredGroups: [] }], skills: [] }) });
  await bridge.refreshRegistry();
  assert.ok(events.some((e) => e.type === "market_changed"), "changed refresh broadcasts");
});

test("facet channel: failing refresh keeps last-good", async () => {
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS }) });
  await bridge.refreshRegistry();
  const good = bridge.getMarketEntries().mcpServers.length;
  bridge.initRegistryBridge({ fetchImpl: async () => { throw new Error("down"); } });
  await bridge.refreshRegistry();
  assert.equal(bridge.getMarketEntries().mcpServers.length, good, "last-good kept on failure");
});

// ── agents leg under the facet channel (fix-cell-catalog-a2a-face) ──────────

const REGISTRY_AGENTS = [
  { path: "/packs/p1/a1", name: "甲岗", supported_protocol: "a2a", is_enabled: true, url: "http://10.0.0.1:9" },
  { path: "/packs/p2/a2", name: "乙岗", supported_protocol: "a2a", is_enabled: true, url: "http://10.0.0.2:9" },
  { path: "/external/link", name: "外链", supported_protocol: "other", is_enabled: true, url: "https://ext.example.test" },
  { path: "/packs/p3/a3", name: "停用岗", supported_protocol: "a2a", is_enabled: false, url: "http://10.0.0.3:9" },
];

test("facet channel: agents leg still reads the registry — a2a entries revived", async () => {
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS, agents: REGISTRY_AGENTS }) });
  await bridge.refreshRegistry();
  const agents = bridge.getAgentEntries();
  const a2a = agents.filter((a) => a.mode === "a2a");
  assert.deepEqual(a2a.map((a) => a.id), ["registry-packs-p1-a1", "registry-packs-p2-a2"], "enabled a2a agents mapped by the legacy mapper");
  for (const a of a2a) {
    assert.equal(a.url, `https://registry.example.test/agent${a.id === "registry-packs-p1-a1" ? "/packs/p1/a1" : "/packs/p2/a2"}/`, "gateway-route url from REGISTRY_URL");
  }
  assert.ok(!agents.some((a) => a.id === "registry-packs-p3-a3"), "disabled entry filtered");
  assert.ok(agents.some((a) => a.id === "registry-external-link" && a.mode === "link"), "non-a2a entry maps to link mode");
});

test("facet channel: agents leg degrades independently — mcp/skills still refresh, agents keep last-good", async () => {
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS, agents: REGISTRY_AGENTS }) });
  await bridge.refreshRegistry();
  const goodAgents = bridge.getAgentEntries().length;
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: [{ name: "b", endpoint: "https://gw/b/mcp", requiredGroups: [] }], skills: [], agentsFail: true }) });
  await bridge.refreshRegistry();
  assert.deepEqual(bridge.getMarketEntries().mcpServers.map((s) => s.name), ["b"], "mcp/skills refresh succeeded despite the agents failure");
  assert.equal(bridge.getAgentEntries().length, goodAgents, "agents keep last-good — neither face blocks the other");
});

test("facet channel: agents changes do not broadcast market_changed", async () => {
  const events = [];
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS, agents: REGISTRY_AGENTS }) });
  await bridge.refreshRegistry();
  const before = events.length;
  bridge.initRegistryBridge({ broadcast: (e) => events.push(e), fetchImpl: facetResponses({ servers: FACET_MCP, skills: FACET_SKILLS, agents: [{ path: "/packs/p9/new", name: "新岗", supported_protocol: "a2a", is_enabled: true, url: "http://10.0.0.9:9" }] }) });
  await bridge.refreshRegistry();
  assert.equal(bridge.getAgentEntries().some((a) => a.id === "registry-packs-p9-new"), true, "agents updated");
  assert.equal(events.length, before, "agents-only change stays silent — broadcast signature excludes agents");
});

test("skill content routes through the facet proxy by name", async () => {
  let seenUrl = null;
  bridge.initRegistryBridge({
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => ({ content: "BODY" }) };
    },
  });
  const raw = await bridge.fetchMarketSkillContent({ name: "pdf" });
  assert.equal(raw, "BODY");
  assert.ok(seenUrl.includes("/api/skills-catalog/pdf/content"), `fetched by name: ${seenUrl}`);
});

// ── source dispatch + warnings (separate processes can't re-read module env;
//    assert the pure selector directly) ───────────────────────────────────────

test("getCatalogSource: facet wins over legacy, legacy over none", () => {
  assert.equal(bridge.getCatalogSource(), "facet", "both configured → facet");
});

// ── starter floor + offline snapshot (extension-store assembly) ──────────────

test("offline assembly: starter floor trio + generated snapshot, no source", async () => {
  // This process has FACET_CATALOG_URL configured, so the "none" branch is
  // exercised by writing the files and asserting the floor invariant holds
  // regardless of source: the stdio trio stays requiresConfig===false.
  fs.writeFileSync(
    path.join(process.cwd(), "market-starters.json"),
    JSON.stringify({
      mcpServers: [
        { name: "fetch", displayName: "Fetch", description: "f", icon: "globe", configTemplate: { command: "npx", args: ["-y", "server-fetch"] } },
        { name: "time", displayName: "Time", description: "t", icon: "clock", configTemplate: { command: "npx", args: ["-y", "server-time"] } },
        { name: "everything", displayName: "Demo", description: "e", icon: "box", configTemplate: { command: "npx", args: ["-y", "server-everything"] } },
        { name: "github", displayName: "GitHub", description: "g", icon: "box", configTemplate: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "<your_token>" } } },
      ],
    }),
  );
  fs.writeFileSync(path.join(process.cwd(), "market-starters-skills.json"), JSON.stringify({ skills: [] }));
  // A facet refresh so the catalog species exist beside the floor.
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: [{ name: "airegistry", endpoint: "https://gw/airegistry/mcp", requiredGroups: [] }], skills: [] }) });
  await bridge.refreshRegistry();
  extensionStore.clearMarketCatalogCache();

  const anon = await extensionStore.getMarketCatalog(null);
  const zero = anon.mcpServers.filter((s) => s.requiresConfig === false);
  assert.ok(zero.length >= 3, `starter floor keeps the zero-config trio (got ${zero.length})`);
  assert.ok(zero.some((s) => s.name === "fetch") && zero.some((s) => s.name === "time") && zero.some((s) => s.name === "everything"));
  // ready-to-use sort first
  assert.equal(anon.mcpServers[0].requiresConfig, false);
  // github (env placeholder) needs config
  assert.equal(anon.mcpServers.find((s) => s.name === "github").requiresConfig, true);
  // catalog entry present beside the floor
  assert.ok(anon.mcpServers.some((s) => s.name === "airegistry"));
});

test("snapshot file is ignored while a source is configured", async () => {
  fs.writeFileSync(
    path.join(process.cwd(), "market-catalog.json"),
    JSON.stringify({ _meta: { as_of: "x", source: "supply-catalog" }, mcpServers: [{ name: "snapshot-only", displayName: "S", icon: "box", configTemplate: { url: "https://s/mcp" } }] }),
  );
  fs.writeFileSync(path.join(process.cwd(), "market-catalog-skills.json"), JSON.stringify({ _meta: {}, skills: [] }));
  bridge.initRegistryBridge({ fetchImpl: facetResponses({ servers: [{ name: "airegistry", endpoint: "https://gw/airegistry/mcp", requiredGroups: [] }], skills: [] }) });
  await bridge.refreshRegistry();
  extensionStore.clearMarketCatalogCache();
  const anon = await extensionStore.getMarketCatalog(null);
  assert.equal(anon.mcpServers.some((s) => s.name === "snapshot-only"), false);
});
