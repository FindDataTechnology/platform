// Unit tests — copilot focused-preset resolution (copilot-dock-focused-preset, tasks 1.1-1.3).
// Run: node --test scripts/test-copilot-presets.mjs
//
//   1.x  resolver: the three official assistant manifests resolve to their own
//        line and never cross lines; a write tool, an undeclared/fullSurface
//        reference, a skipped agent, or a server outside the line each reject;
//        two candidates → the most recent wins and the warning names the other;
//        line → servers and the gated write-tool set are derived, not typed.
//   2.x  route GET /api/boards/:line/copilot: switch off → 404; unknown line →
//        404; installed facet assistant → its agent for facet and null for
//        wanxing; the board adapter is never run.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-presets-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
delete process.env.LINE_BOARDS_ENABLED;

const db = await import("../db.js");
await db.initDb();
const { resolveCopilotPreset, lineServersFromRegistry, gatedWriteTools, copilotPresetForLine } = await import("../lib/copilot-presets.js");
const { listActions } = await import("../lib/action-registry.js");
const { WIRE_TOOL_RISK, WIRE_WRITE_TOOLS } = await import("../lib/wire-tool-risk.js");
const { getBoardAdapter, resolveView } = await import("../lib/board-adapters.js");
const { registerBoardRoutes } = await import("../server/routes/boards.js");

const OFFICIAL = path.join(process.cwd(), "docs", "official-packs");
const manifest = (file) => JSON.parse(fs.readFileSync(path.join(OFFICIAL, file), "utf8"));
const FACET = manifest("facet-assistant-manifest.json");
const WANXING = manifest("wanxing-fleet-assistant-manifest.json");
const WIRE = manifest("wire-assistant-manifest.json");

// An installed-pack row the way listInstalledPacks hydrates it; every agent
// in the manifest materialized unless `skipped` names it.
const installed = (packId, m, { installedAt = "2026-10-22T00:00:00.000Z", skipped = [] } = {}) => ({
  packId,
  name: m.name,
  version: 1,
  manifest: m,
  report: {
    agents: (m.agents ?? []).map((a) => ({ id: a.id, status: skipped.includes(a.id) ? "skipped" : "installed" })),
  },
  installedAt,
});

const quiet = { warn: () => {} };

test("1.1 each official assistant resolves to its own line only", () => {
  const packs = [installed("p-facet", FACET), installed("p-wanxing", WANXING), installed("p-wire", WIRE)];
  const facet = resolveCopilotPreset("facet", packs, quiet);
  assert.equal(facet?.packId, "p-facet");
  assert.equal(facet?.agentId, FACET.agents[0].id);
  assert.equal(facet?.agentName, "谦面助手");
  assert.equal(resolveCopilotPreset("wanxing", packs, quiet)?.packId, "p-wanxing");
  assert.equal(resolveCopilotPreset("wire", packs, quiet)?.packId, "p-wire");
  // Cross-line: only the facet pack installed → the other lines see nothing.
  const onlyFacet = [installed("p-facet", FACET)];
  assert.equal(resolveCopilotPreset("wanxing", onlyFacet, quiet), null);
  assert.equal(resolveCopilotPreset("wire", onlyFacet, quiet), null);
});

test("1.2 a pack whose allowlist carries a gated write tool is not a focused assistant", () => {
  const m = structuredClone(FACET);
  m.mcpServers[0].allowTools.push("facet_market_pack_visibility");
  assert.equal(resolveCopilotPreset("facet", [installed("p-bad", m)], quiet), null);
  // The wire blocklist comes from the vendored tool_risk snapshot, not the registry.
  const w = structuredClone(WIRE);
  w.mcpServers[1].allowTools.push("wire_artifact_update");
  assert.equal(resolveCopilotPreset("wire", [installed("p-bad-wire", w)], quiet), null);
});

test("1.3 an undeclared or fullSurface reference composes the whole surface → rejected", () => {
  const undeclared = structuredClone(FACET);
  delete undeclared.mcpServers[1].allowTools;
  assert.equal(resolveCopilotPreset("facet", [installed("p-undeclared", undeclared)], quiet), null);
  const empty = structuredClone(FACET);
  empty.mcpServers[1].allowTools = [];
  assert.equal(resolveCopilotPreset("facet", [installed("p-empty", empty)], quiet), null);
  const full = structuredClone(FACET);
  full.mcpServers[0].fullSurface = true;
  assert.equal(resolveCopilotPreset("facet", [installed("p-full", full)], quiet), null);
});

test("1.4 a server outside the line, or a skipped agent, rejects", () => {
  const mixed = structuredClone(FACET);
  mixed.mcpServers.push({ registryName: "wanxing-ops-mcp", allowTools: ["wanxing_agents_browse"] });
  assert.equal(resolveCopilotPreset("facet", [installed("p-mixed", mixed)], quiet), null);
  assert.equal(resolveCopilotPreset("wanxing", [installed("p-mixed", mixed)], quiet), null);
  // A pack whose agent lost the catalog id to an earlier install has it
  // `skipped` in the report; it must not be reported as a usable preset.
  assert.equal(resolveCopilotPreset("facet", [installed("p-skipped", FACET, { skipped: [FACET.agents[0].id] })], quiet), null);
  const noAgents = structuredClone(FACET);
  noAgents.agents = [];
  assert.equal(resolveCopilotPreset("facet", [installed("p-noagent", noAgents)], quiet), null);
});

test("1.5 two candidates → the most recently installed wins and the warning names the other", () => {
  const older = installed("p-older", FACET, { installedAt: "2026-10-01T00:00:00.000Z" });
  const newer = installed("p-newer", { ...structuredClone(FACET), name: "谦面助手·社区版" }, { installedAt: "2026-10-20T00:00:00.000Z" });
  const warnings = [];
  const pick = resolveCopilotPreset("facet", [older, newer], { warn: (m) => warnings.push(m) });
  assert.equal(pick?.packId, "p-newer");
  assert.equal(pick?.packName, "谦面助手·社区版");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 focused assistant packs/);
  assert.match(warnings[0], /谦面助手·社区版/);
  assert.match(warnings[0], /others: 谦面助手/);
  // Order of the input list does not change the pick.
  assert.equal(resolveCopilotPreset("facet", [newer, older], quiet)?.packId, "p-newer");
});

test("1.6 line → servers and the write-tool set are derived from the registry + wire snapshot", () => {
  const byLine = lineServersFromRegistry();
  assert.deepEqual([...byLine.get("facet")].sort(), ["facet-market-mcp", "facet-ops-mcp"]);
  assert.deepEqual([...byLine.get("wanxing")].sort(), ["wanxing-ops-mcp"]);
  const wireServers = new Set(Object.values(WIRE_TOOL_RISK).map((e) => e.server));
  assert.deepEqual([...byLine.get("wire")].sort(), [...wireServers].sort());
  const write = gatedWriteTools();
  for (const t of WIRE_WRITE_TOOLS) assert.ok(write.has(t), `wire write tool ${t} gated`);
  // Only WRITE-tier actions belong in the gated set (unify-copilot-workbench
  // 1.6): `read` actions are the copilot's admissible tools, so asserting they
  // are gated would re-introduce the very bug that made board_read unusable.
  for (const a of listActions()) {
    if (!a.tool) continue;
    if (a.risk === "read") assert.ok(!write.has(a.tool), `read tool ${a.tool} must NOT be gated`);
    else assert.ok(write.has(a.tool), `registry tool ${a.tool} gated`);
  }
  assert.ok(
    listActions().some((a) => a.risk === "read"),
    "the registry must carry at least one read action, or the copilot has no evidence tool",
  );
  // No official assistant's read face collides with the blocklist (the publish
  // lint's invariant, re-asserted here because the resolver depends on it).
  for (const m of [FACET, WANXING, WIRE]) {
    for (const ref of m.mcpServers) for (const t of ref.allowTools) assert.ok(!write.has(t), `${m.name} declares write tool ${t}`);
  }
});

test("1.7 unknown line and empty input resolve to null", () => {
  assert.equal(resolveCopilotPreset("lex", [installed("p-facet", FACET)], quiet), null);
  assert.equal(resolveCopilotPreset("facet", [], quiet), null);
  assert.equal(resolveCopilotPreset("facet", null, quiet), null);
});

// ── 2.x route ────────────────────────────────────────────────────────────────

const mockRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

const routes = {};
registerBoardRoutes({ app: { get: (p, h) => { routes[p] = h; } } });
const copilotRoute = routes["/api/boards/:line/copilot"];
assert.ok(copilotRoute, "copilot route registered");

test("2.1 switch off → 404 line_boards_disabled", async () => {
  delete process.env.LINE_BOARDS_ENABLED;
  const res = mockRes();
  await copilotRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "line_boards_disabled");
});

test("2.2 unknown line → 404 line_not_found with the available lines", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  const res = mockRes();
  // A genuinely unknown id: `lex` was this test's stand-in for "unknown" until
  // it gained its own board adapter (add-lex-line-board), which made the case
  // resolve 200. The subject is the unknown-line branch, not lex.
  await copilotRoute({ params: { line: "no-such-line" }, user: { email: "o@test.example" } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "line_not_found");
  assert.ok(res.body.availableLines.includes("facet"));
});

test("2.3 installed facet assistant → its agent for facet, null for wanxing; adapter never runs", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  const row = installed("qCEIutJzQd49jnDtV4qeqw", FACET);
  db.upsertInstalledPack({ packId: row.packId, name: row.name, version: 1, manifest: row.manifest, report: row.report });

  // The route must not touch the board adapter: make it explode if it does.
  const facetAdapter = getBoardAdapter("facet");
  const wanxingAdapter = getBoardAdapter("wanxing");
  const origFacet = facetAdapter.fetchBlocks;
  const origWanxing = wanxingAdapter.fetchBlocks;
  facetAdapter.fetchBlocks = async () => { throw new Error("adapter must not run for /copilot"); };
  wanxingAdapter.fetchBlocks = async () => { throw new Error("adapter must not run for /copilot"); };
  try {
    const facet = mockRes();
    await copilotRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, facet);
    assert.equal(facet.statusCode, 200);
    assert.equal(facet.body.line, "facet");
    assert.equal(facet.body.copilot?.agentId, FACET.agents[0].id);
    assert.equal(facet.body.copilot?.packId, "qCEIutJzQd49jnDtV4qeqw");
    assert.equal(facet.body.copilot?.packName, "谦面助手");

    const wanxing = mockRes();
    await copilotRoute({ params: { line: "wanxing" }, user: { email: "o@test.example" } }, wanxing);
    assert.equal(wanxing.statusCode, 200);
    assert.deepEqual(wanxing.body, { line: "wanxing", copilot: null });

    // The DB-backed entry point agrees with the route.
    assert.equal((await copilotPresetForLine("facet"))?.agentId, FACET.agents[0].id);
  } finally {
    facetAdapter.fetchBlocks = origFacet;
    wanxingAdapter.fetchBlocks = origWanxing;
    db.deleteInstalledPack(row.packId);
  }
});

// ── 1.6/1.7 (unify-copilot-workbench): a READ action is admissible ───────────
//
// The face invariant is "no WRITE tool", and the first read action lands in
// this change (board.read). If gatedWriteTools counted it, every pack that
// lists board_read would be disqualified — the tool would ship unusable AND
// nothing would say so. These two assertions are the tripwire.

test("1.6 board.read is registered at the read tier and nothing else", () => {
  const action = listActions().find((a) => a.id === "board.read");
  assert.ok(action, "board.read must be registered");
  assert.equal(action.risk, "read");
  assert.equal(action.tool, "board_read");
  assert.equal(action.line, null, "a line-parameterized tool must not join any line's server set");
});

test("1.7 a pack whose allowlist includes board_read is still a valid focused face", () => {
  const writeTools = gatedWriteTools();
  assert.equal(writeTools.has("board_read"), false, "board_read is a READ tool, not a gated write");
  // Every other registered tool still counts — the exclusion is by risk, not
  // by name, so no write action slipped through with it.
  for (const a of listActions()) {
    if (a.risk === "read") continue;
    if (typeof a.tool !== "string" || !a.tool) continue;
    assert.ok(writeTools.has(a.tool), `${a.id}'s tool ${a.tool} must still be gated`);
  }
});

test("1.7 the resolver still rejects a pack that lists a real write tool alongside a read one", () => {
  // The mixed case is the one that matters: adding a read tool must not make
  // the resolver blind to the write tool sitting next to it.
  const mixed = {
    ...FACET,
    mcpServers: FACET.mcpServers.map((ref, i) =>
      i === 0 ? { ...ref, allowTools: [...ref.allowTools, "board_read", "facet_market_pack_visibility"] } : ref,
    ),
  };
  assert.equal(resolveCopilotPreset("facet", [installed("p-mixed", mixed)], quiet), null);
});

// ── 2.4 catalog × view route (unify-copilot-workbench B2) ────────────────────
//
// The compatibility contract: with no stored view, `blocks` is what the adapter
// returned — same order, same content. A view then reorders/filters without the
// catalog changing underneath.

const boardRoute = routes["/api/boards/:line"];
assert.ok(boardRoute, "board route registered");

const CATALOG = [
  { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览" },
  { id: "my_packs", type: "list", tab: "mine", title: "我的包" },
  { id: "publish_history", type: "timeline", tab: "mine", title: "发布记录" },
];

async function withFakeAdapter(line, blocks, fn) {
  const adapter = getBoardAdapter(line);
  const orig = adapter.fetchBlocks;
  adapter.fetchBlocks = async () => ({ connected: true, blocks });
  try {
    return await fn();
  } finally {
    adapter.fetchBlocks = orig;
  }
}

test("2.4 no stored view → blocks/tabs identical to the adapter's catalog", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  db.setPreference("board.view.facet", null);
  await withFakeAdapter("facet", CATALOG, async () => {
    const res = mockRes();
    await boardRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.blocks.map((b) => b.id), CATALOG.map((b) => b.id));
    assert.deepEqual(res.body.tabs, ["overview", "mine"]);
    assert.deepEqual(res.body.catalog.map((b) => b.id), CATALOG.map((b) => b.id));
    assert.equal(res.body.view, null, "never configured reports null, not an empty list");
    assert.equal("droppedBlocks" in res.body, false);
  });
});

test("2.4 a stored view reorders and filters; tabs follow what is rendered", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  db.setPreference(
    "board.view.facet",
    JSON.stringify([
      { blockId: "publish_history", tab: "mine", order: 0 },
      { blockId: "retired_block", order: 1 },
      { blockId: "my_packs", tab: "mine", order: 2 },
    ]),
  );
  await withFakeAdapter("facet", CATALOG, async () => {
    const res = mockRes();
    await boardRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
    assert.deepEqual(res.body.blocks.map((b) => b.id), ["publish_history", "my_packs"]);
    // `overview` had exactly one block and the view dropped it → the tab goes
    // with it rather than lingering as an empty strip.
    assert.deepEqual(res.body.tabs, ["mine"]);
    assert.deepEqual(res.body.droppedBlocks, ["retired_block"]);
    // The catalog still lists everything — the view is a selection, not a delete.
    assert.equal(res.body.catalog.length, CATALOG.length);
  });
  db.setPreference("board.view.facet", null);
});

test("2.4 an unconnected board ignores any stored view (there is nothing to arrange)", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  db.setPreference("board.view.facet", JSON.stringify([{ blockId: "my_packs", order: 0 }]));
  const adapter = getBoardAdapter("facet");
  const orig = adapter.fetchBlocks;
  adapter.fetchBlocks = async () => ({
    connected: false,
    reason: "not_connected",
    connectPath: "/settings/connections",
    blocks: [{ id: "connection", type: "metrics", tab: "overview", title: "连接状态", error: "未连接" }],
  });
  try {
    const res = mockRes();
    await boardRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
    // The not-connected card is the ONLY thing that may render here: a view
    // pointing elsewhere must not hide the one block telling the user to connect.
    assert.deepEqual(res.body.blocks.map((b) => b.id), ["connection"]);
  } finally {
    adapter.fetchBlocks = orig;
    db.setPreference("board.view.facet", null);
  }
});

// ── 2.6 chart block hydration (unify-copilot-workbench B2) ──────────────────

test("2.6 a chart view entry is not 'dropped' — it has no catalog block by design", () => {
  const view = [
    { blockId: "chart:r1", order: 0, tab: "overview", resourceId: "r1", title: "华南销量" },
    { blockId: "my_packs", order: 1, tab: "mine" },
  ];
  const { blocks, dropped } = resolveView({ userView: view, catalog: CATALOG });
  assert.deepEqual(dropped, [], "a chart reference is legitimate, not a retired id");
  assert.equal(blocks[0].id, "chart:r1");
  assert.equal(blocks[0].type, "chart");
  assert.equal(blocks[0].resourceId, "r1");
  assert.equal(blocks[1].id, "my_packs");
});

test("2.6 a chart whose resource vanished degrades per-block, board still renders", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  db.setPreference(
    "board.view.facet",
    JSON.stringify([
      { blockId: "chart:missing", order: 0, tab: "overview", resourceId: "no-such-resource" },
      { blockId: "my_packs", order: 1, tab: "mine" },
    ]),
  );
  await withFakeAdapter("facet", CATALOG, async () => {
    const res = mockRes();
    await boardRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
    assert.equal(res.statusCode, 200);
    const chartBlock = res.body.blocks.find((b) => b.type === "chart");
    assert.ok(chartBlock, "the chart block is still present");
    assert.ok(chartBlock.error, "…but carries a per-block error");
    assert.equal(chartBlock.data, null, "never an empty chart's option");
    // The neighbour is untouched — one bad chart does not take the board down.
    assert.ok(res.body.blocks.some((b) => b.id === "my_packs" && !b.error));
  });
  db.setPreference("board.view.facet", null);
});

test("2.6 a live chart resource is hydrated to an option by the server", async () => {
  process.env.LINE_BOARDS_ENABLED = "1";
  const option = { xAxis: { type: "category", data: ["a", "b"] }, series: [{ type: "line", data: [1, 2] }] };
  const inserted = db.insertResource({
    id: "chart-live-1",
    type: "chart",
    title: "销量趋势",
    source: "manual",
    payload: JSON.stringify(option),
    contentHash: "hash-live-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  assert.equal(inserted.inserted, true, "fixture resource inserted");
  db.setPreference(
    "board.view.facet",
    JSON.stringify([{ blockId: "chart:chart-live-1", order: 0, tab: "overview", resourceId: "chart-live-1" }]),
  );
  await withFakeAdapter("facet", CATALOG, async () => {
    const res = mockRes();
    await boardRoute({ params: { line: "facet" }, user: { email: "o@test.example" } }, res);
    const chartBlock = res.body.blocks.find((b) => b.type === "chart");
    assert.equal(chartBlock.error, undefined);
    assert.deepEqual(chartBlock.data, option);
    assert.equal(chartBlock.title, "销量趋势", "falls back to the resource title");
  });
  db.setPreference("board.view.facet", null);
});
