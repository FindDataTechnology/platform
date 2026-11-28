#!/usr/bin/env node
// ── Per-post server trimming (trim-mcp-injection-per-post 2.x) ──────────────
//
// The cell composes ONE mcp.patch.yml for every persona, so all 34 servers'
// schemas are in scope regardless of which post runs. 2026-11-09/10 the owner
// cell carried 34 servers while a single post referenced 3, and after cron
// session rotation shipped a FRESH round still died with "turn stopped early —
// context pressure (4 compactions)": a new session starts out already near the
// window. Rotation cures "worse the longer it runs"; trimming cures "starts
// out too high". Both are needed.
//
// Safety valve pinned first: a post that declares NOTHING must keep the full
// composition. Dropping servers for an undeclared face would silently remove
// tools from a working post — strictly worse than a fat context.
//
//   node --test scripts/test-mcp-post-trim.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { trimServersToFace, serversFromFace, describeTrim, dedupeServerEntries } = await import(
  path.join(here, "../lib/mcp-post-trim.js")
);

const row = (name) => ({ id: `mcp-${name}`, config: { serverName: name } });

const CELL = [
  "facet-market", "wire-ops", "lex-ops", "fd-erp-ledger-mcp", "actions", "fleet",
  "bench-proposal", "library", "cron", "delegation", "airegistry-tools", "blueprint-author",
  "chatwoot", "facet-market-mcp", "facet-ops-mcp", "fd-cn-report", "fd-daas-mcp",
  "fd-find-data-business-mcp", "fd-info", "fd-open-data-mcp", "fd-quant", "fd-sentiment",
  "fd-text-core", "fleet-architect", "infra-telemetry", "pack-author", "persona-evolution",
  "playwright", "skill-evolution", "websearch", "wire-build-mcp", "wire-ops-mcp",
  "connector_chat_explore_ba29f742", "fd-memory",
].map(row);

test("1. the live cell shape: 34 servers trimmed to the constructor's 3", () => {
  const face = {
    "fleet-architect": ["fleet_list", "fleet_spec_read", "fleet_draft", "fleet_turns_read"],
    "facet-market": ["facet_market_pack_browse"],
    "actions-mcp": ["propose_action"],
  };
  const allowed = serversFromFace(face);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  const names = out.map((e) => e.config.serverName).sort();
  // actions-mcp has no row in CELL (the cell carries "actions"), so the trim
  // keeps only what exists — never invents a row for a declared-but-absent name.
  // `fleet` rides along: it carries report_status, a platform obligation.
  assert.deepEqual(names, ["facet-market", "fd-memory", "fleet", "fleet-architect"]);
  assert.ok(out.length <= 4, `expected <=4 servers, got ${out.length}`);
});

test("2. SAFETY VALVE: an empty/absent face keeps the full composition", () => {
  assert.equal(trimServersToFace(CELL, {}).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: null }).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: [] }).length, CELL.length);
  assert.equal(trimServersToFace(CELL, { allowed: serversFromFace(null) }).length, CELL.length);
});

test("3. the memory row survives a trim even when the face omits it", () => {
  const allowed = new Set(["fleet-architect"]);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  assert.ok(out.some((e) => e.config.serverName === "fd-memory"));
  const withoutKeep = trimServersToFace(CELL, { allowed, keepMemory: false });
  assert.ok(!withoutKeep.some((e) => e.config.serverName === "fd-memory"));
});

test("4. the input array is never mutated (the shared patch keeps serving chat)", () => {
  const before = CELL.length;
  const out = trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]) });
  assert.equal(CELL.length, before, "input length unchanged");
  assert.notEqual(out, CELL, "a new array comes back");
});

test("5. malformed rows are dropped, not kept by accident", () => {
  const junk = [{ id: "x" }, { config: {} }, { config: { serverName: "" } }, row("fleet-architect")];
  const out = trimServersToFace(junk, { allowed: new Set(["fleet-architect"]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].config.serverName, "fleet-architect");
});

test("6. serversFromFace tolerates junk and de-duplicates", () => {
  assert.deepEqual([...serversFromFace({ a: [], a2: [], b: [] })].sort(), ["a", "a2", "b"]);
  assert.equal(serversFromFace(null).size, 0);
  assert.equal(serversFromFace([1, 2]).size, 0, "an array is not a face map");
  assert.equal(serversFromFace({ "": [], x: [] }).size, 1, "empty key is not a server");
});

test("7. describeTrim reports the reduction honestly", () => {
  // fleet-architect (declared) + fleet (report lane) + nothing else.
  assert.equal(describeTrim(CELL, trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]) })),
    "trimmed 34 → 2 server(s) (dropped 32)");
  assert.equal(describeTrim(CELL, CELL), "trimmed 34 → 34 server(s)");
});

// ── faceForPresetFromPacks ──────────────────────────────────────────────────
// The wiring half: the writer's safety valve keeps all 34 servers unless a
// face is actually resolved. 2026-11-10 production logged
// "injection surface: 34 MCP server(s)" with NO trim line, because the only
// caller passed no face. These pin the resolver's contract.

// Importing dsh-profile.js would pull js-yaml and the whole profile stack into
// a pure-function test (and fails in a bare worktree without node_modules).
// The resolver is imported lazily and guarded so the trim contract still
// runs everywhere; the resolver cases skip only when the module is absent.
let faceForPresetFromPacks = null;
try {
  ({ faceForPresetFromPacks } = await import(path.join(here, "../dsh-profile.js")));
} catch (e) {
  console.warn(`[test] faceForPresetFromPacks unavailable (${e.code || e.message}); resolver cases skipped`);
}

const packWith = (agentId, tools) => ({
  manifest: {
    mcpServers: Object.entries(tools).map(([registryName, allowTools]) => ({ registryName, allowTools })),
    agents: [{ id: agentId, resources: {} }],
  },
});

test("8. resolves the declared face for a preset, merging repeat declarations", { skip: !faceForPresetFromPacks }, () => {
  const packs = [
    packWith("hc-architect", { "fleet-architect": ["fleet_list", "fleet_draft"], "facet-market": ["browse"] }),
    packWith("hc-architect", { "fleet-architect": ["fleet_turns_read"] }),
    packWith("mo-inventory", { fleet: ["report_status"] }),
  ];
  const face = faceForPresetFromPacks(packs, "hc-architect");
  assert.deepEqual(Object.keys(face).sort(), ["facet-market", "fleet-architect"]);
  assert.deepEqual(face["fleet-architect"].sort(), ["fleet_draft", "fleet_list", "fleet_turns_read"]);
});

test("9. an unknown preset resolves to null — the safety valve keeps full composition", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWith("hc-architect", { "fleet-architect": ["fleet_list"] })];
  assert.equal(faceForPresetFromPacks(packs, "nobody-here"), null);
  assert.equal(faceForPresetFromPacks(null, "hc-architect"), null);
  assert.equal(faceForPresetFromPacks(packs, ""), null);
});

test("10. roster-form and catalog-form ids both resolve", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWith("hc.architect", { "fleet-architect": ["fleet_list"] })];
  assert.ok(faceForPresetFromPacks(packs, "hc-architect"), "dotted catalog id normalizes to roster form");
});

test("11. REGRESSION: the fleet server (report_status) survives every trim", () => {
  // Live 2026-11-10: trimming by declared face dropped `fleet`, which carries
  // report_status. The inventory post then produced a complete five-column
  // ledger in its TEXT (out=871) and filed nothing — the trace shows it calling
  // tool_search{"query":"report_status"} twice, hunting a tool that was gone.
  // The report lane is a platform obligation, not a declared capability.
  const out = trimServersToFace(CELL, { allowed: new Set(["fleet-architect"]), keepMemory: true });
  const names = out.map((e) => e.config.serverName);
  assert.ok(names.includes("fleet"), "report_status must always be reachable");
  assert.ok(names.includes("fd-memory"), "memory survives too");
  assert.ok(names.includes("fleet-architect"), "the declared face survives");
  assert.equal(out.length, 3, "and nothing else came along");
});

test("12. the live 4-server shape keeps the report lane", () => {
  // The exact set that shipped and broke reporting: facet-market / fleet-architect
  // / wire-build-mcp / fd-memory. Adding the missing lane must not change the
  // rest — `fleet` is additive, never a replacement for a declared server.
  const allowed = new Set(["facet-market", "fleet-architect", "wire-build-mcp"]);
  const out = trimServersToFace(CELL, { allowed, keepMemory: true });
  assert.deepEqual(out.map((e) => e.config.serverName).sort(),
    ["facet-market", "fd-memory", "fleet", "fleet-architect", "wire-build-mcp"]);
});

// ── 平台义务：读面也不该由 pack 声明（baseline-fleet-bridge-for-member-pods）──
//
// 平台每轮注入岗位身份，就必须保证这个岗位读得到自己的舰队；只留 `fleet`
// 等于「能报数、看不见」。2026-11-14 实测：4 票「fleet_list/fleet_turns_read/
// fleet_spec_read 不可调用」而报数正常；37 个已装 pack 里声明 fleet-architect
// 的只有 4 个。
test("义务豁免: 岗位没声明读面时，fleet + fleet-architect 仍被保住", () => {
  const allowed = new Set(["facet-market"]); // 一个既不含 fleet 也不含读面的岗位面
  const names = trimServersToFace(CELL, { allowed, keepMemory: true })
    .map((e) => e.config.serverName)
    .sort();
  assert.deepEqual(names, ["facet-market", "fd-memory", "fleet", "fleet-architect"]);
});

test("义务豁免不新增行: insert 里本来没有的服务器，裁完也不会有", () => {
  const withoutArch = CELL.filter((e) => e.config.serverName !== "fleet-architect");
  const names = trimServersToFace(withoutArch, { allowed: new Set(["facet-market"]), keepMemory: true })
    .map((e) => e.config.serverName);
  assert.ok(!names.includes("fleet-architect"), "上层裁掉的行不许被这里救回来（公开面收窄优先）");
});

// 3.2 的两条「上游收窄仍然优先」都落在同一个结构上：豁免只保留 insert 已有行。
// ① publicFacing：公开面的 keep-set 在 dsh-profile 里按 isPublicFace 删名字
//    （PUBLIC_FACE_DEFAULT 不含 fleet-architect）⇒ insert 里没有它；
//    行为断言在 scripts/test-external-team-chat-lane.mjs。
// ② 显式停用：用户/DB 关闭在 availability 过滤阶段就删掉了行 ⇒ insert 里没有它；
//    compose 层断言见 scripts/test-focus-overlay.mjs「a personal disable still
//    wins over the platform baseline」。
test("3.2 显式停用仍生效: 被用户关掉的行不在 insert 里，豁免不会把它带回来", () => {
  // 用一张「恰好只剩报数面、读面被停用」的 insert，模拟 availability 过滤后的形状。
  const disabledArch = CELL.filter((e) => e.config.serverName !== "fleet-architect");
  const names = trimServersToFace(disabledArch, { allowed: new Set(["fleet"]), keepMemory: true })
    .map((e) => e.config.serverName)
    .sort();
  assert.deepEqual(names, ["fd-memory", "fleet"], "显式停用的读面不得因豁免而复活");
});

// ── 显式空 vs 未声明（pack-injection-surface，2026-11-27 生产实测）──────────
//
// 13 个已装包声明零 MCP，推出 24 个 persona；它们的角色文本全都在调
// report_status / escalate（fleet 的工具）。旧实现把「角色没写声明」和
// 「角色写了空声明」都归一成 null ⇒ 不裁剪 ⇒ 48.3% 的回合跑在 ≥12 个
// server 的面上。空集现在可以表达「只留平台义务」，但那必须是调用方的
// 显式选择，旧的空集语义不变。

const OBLIGATION_ROWS = [
  { config: { serverName: "fleet" } },
  { config: { serverName: "fleet-architect" } },
  { config: { serverName: "fd-memory" } },
  { config: { serverName: "playwright" } },
  { config: { serverName: "trade" } },
];
const names = (rows) => rows.map((e) => e.config.serverName);

test("空集默认仍是不裁剪（旧语义不许被静默改掉）", () => {
  assert.deepEqual(names(trimServersToFace(OBLIGATION_ROWS, { allowed: new Set(), keepMemory: true })), names(OBLIGATION_ROWS));
});

test("显式要求时，空集裁到平台义务（fleet / fleet-architect / 记忆）", () => {
  const out = trimServersToFace(OBLIGATION_ROWS, { allowed: new Set(), keepMemory: true, emptyMeansObligationsOnly: true });
  assert.deepEqual(names(out), ["fleet", "fleet-architect", "fd-memory"]);
});

test("有面时只留面 + 平台义务", () => {
  const out = trimServersToFace(OBLIGATION_ROWS, { allowed: serversFromFace({ trade: [] }), keepMemory: true, emptyMeansObligationsOnly: true });
  assert.deepEqual(names(out), ["fleet", "fleet-architect", "fd-memory", "trade"]);
});

test("null 面 = 未声明 = 一行都不裁", () => {
  assert.deepEqual(names(trimServersToFace(OBLIGATION_ROWS, { allowed: null, keepMemory: true })), names(OBLIGATION_ROWS));
});

// ── 三值解析（pack-injection-surface 1.2）──────────────────────────────────
//
// 2026-11-27 生产实测：59 个已装包里 13 个声明零 MCP，推出 24 个 persona；
// 旧实现把这 13 个包全归到 null（不裁剪），于是 48.3% 的回合跑在 ≥12 个
// server 的面上。但「包零 MCP + 角色没写声明」是**漏写**，不是「不买集成」——
// 一刀切裁到平台义务会让情报岗丢掉搜索工具。所以只有角色自己写了空声明
// （resources.mcpServers: [] 或 resources.mcpTools: {}）才算显式空。

const packWithAgent = (agent) => ({ manifest: { mcpServers: [], agents: [agent] } });

test("10. 角色显式写空声明 ⇒ 解析为 {}（裁到平台义务）", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWithAgent({ id: "ceo-role", resources: { mcpServers: [] } })];
  assert.deepEqual(faceForPresetFromPacks(packs, "ceo-role"), {});
});

test("11. 角色显式写空 mcpTools ⇒ 同样是 {}", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWithAgent({ id: "ceo-role", resources: { mcpTools: {} } })];
  assert.deepEqual(faceForPresetFromPacks(packs, "ceo-role"), {});
});

test("12. 包零 MCP 且角色没写声明 ⇒ 仍是 null（漏写不等于不买集成）", { skip: !faceForPresetFromPacks }, () => {
  const packs = [packWithAgent({ id: "intel-tech", persona: "用可用的搜索工具巡检" })];
  assert.equal(faceForPresetFromPacks(packs, "intel-tech"), null);
});

test("13. 包有 MCP 但角色没写声明 ⇒ 沿用包级 allowTools（裁剪仍生效）", { skip: !faceForPresetFromPacks }, () => {
  const packs = [{ manifest: { mcpServers: [{ registryName: "websearch", allowTools: ["web_search"] }], agents: [{ id: "intel-tech" }] } }];
  const face = faceForPresetFromPacks(packs, "intel-tech");
  assert.deepEqual(Object.keys(face), ["websearch"]);
});

// ── 别名去重（injection-surface-accounting 3.x）────────────────────────────
//
// 生产实测：某个 member patch 同时带 facet-market 与 facet-market-mcp，
// 32 个 server 里有重复；每个 server 的 schema 都进静态前缀，重复就是浪费。
// 但同端点不同凭据是两个租户，绝不能合并。

test("14. 同端点同凭据的两个别名合并为一个，并点名", () => {
  const entries = [
    { id: "mcp-facet-market", config: { serverName: "facet-market", transport: "streamable-http", url: "http://x/mcp/" } },
    { id: "mcp-facet-market-mcp", config: { serverName: "facet-market-mcp", transport: "streamable-http", url: "http://x/mcp" } },
    { id: "mcp-fleet", config: { serverName: "fleet", transport: "streamable-http", url: "http://y/mcp" } },
  ];
  const { entries: out, merged } = dedupeServerEntries(entries);
  assert.deepEqual(out.map((e) => e.config.serverName), ["facet-market", "fleet"]);
  assert.deepEqual(merged, [{ kept: "facet-market", dropped: "facet-market-mcp" }]);
});

test("15. 同端点不同凭据不合并（两个租户是两个服务）", () => {
  const entries = [
    { config: { serverName: "tenant-a", transport: "streamable-http", url: "http://x/mcp", headers: { Authorization: "Bearer a" } } },
    { config: { serverName: "tenant-b", transport: "streamable-http", url: "http://x/mcp", headers: { Authorization: "Bearer b" } } },
  ];
  const { entries: out, merged } = dedupeServerEntries(entries);
  assert.equal(out.length, 2);
  assert.deepEqual(merged, []);
});

test("16. 无 url 的条目按名字去重，不误合并", () => {
  const entries = [
    { config: { serverName: "stdio-a" } },
    { config: { serverName: "stdio-b" } },
    { config: { serverName: "stdio-a" } },
  ];
  const { entries: out, merged } = dedupeServerEntries(entries);
  assert.deepEqual(out.map((e) => e.config.serverName), ["stdio-a", "stdio-b"]);
  assert.equal(merged.length, 1);
});

test("17. 声明了非空 server 但解析不出来 ⇒ 不裁剪（绝不裁成空面）", { skip: !faceForPresetFromPacks }, () => {
  // manifest 没有对应 mcpServers 条目 ⇒ effectiveMcpTools 返回 {}。
  // 若把它当成「显式空」，这个角色会被裁到只剩平台义务——比不裁更糟。
  const packs = [packWithAgent({ id: "intel-tech", resources: { mcpServers: ["websearch"] } })];
  assert.equal(faceForPresetFromPacks(packs, "intel-tech"), null);
});

test("18. 声明非空且能解析 ⇒ 按声明裁剪", { skip: !faceForPresetFromPacks }, () => {
  const packs = [{
    manifest: {
      mcpServers: [{ registryName: "websearch", allowTools: ["web_search"] }],
      agents: [{ id: "intel-tech", resources: { mcpServers: ["websearch"] } }],
    },
  }];
  const face = faceForPresetFromPacks(packs, "intel-tech");
  assert.deepEqual(Object.keys(face), ["websearch"]);
});
