// ── Board routes (add-line-boards-and-action-gate, task 10) ─────────────────
//
// GET /api/boards/:line — fetch a board's blocks
//
// As of unify-copilot-workbench 2.4 the response carries three related keys:
//   catalog  what the adapter offered (the candidate set)
//   view     the user's ordered selection from it (null = never configured)
//   blocks   catalog × view, merged — WHAT TO RENDER
// `blocks` is unchanged in shape and, when no view is stored, unchanged in
// content and order; every pre-view reader keeps working.
//
// Returns { line, title, originUrl, tabs, catalog, view, blocks: [...] } where
// `tabs` is the de-duplicated, first-appearance-ordered set of `tab` values the
// RENDERED blocks declare, and each block has { id, type, title, data?, error? }.
//
// `tabs` is derived from blocks, never declared separately (unify-line-board-tabs
// D1): a front-end table and an adapter list are two sources that drift silently
// — lex's four tabs were shipped by the adapter and never reached the page.
// Deriving from the rendered set also means a view that empties a tab does not
// leave an empty tab strip behind.
//
// Unknown lines return 404 with an honest message.

import {
  getBoardAdapter,
  listBoardLines,
  lineBoardsEnabled,
  resolveView,
  storedViewOrNull,
  tabsOfBlocks,
} from "../../lib/board-adapters.js";
import * as db from "../../db.js";
import { copilotPresetForLine } from "../../lib/copilot-presets.js";

// ── Chart blocks (unify-copilot-workbench 2.6) ──────────────────────────────
//
// A chart block is a REFERENCE, not data: `{ id, type: "chart", resourceId }`.
// The option is hydrated here, server-side, from the saved chart resource — the
// block adapter never carries chart data (design D6: that would make every
// adapter a second chart data source and bloat the board response).
//
// A referenced resource that is missing or whose payload is not a chart option
// degrades to an honest per-block error. It must NOT render an empty chart: an
// empty chart reads as "the value is zero", which is a different claim.
function hydrateChartBlocks(blocks) {
  return blocks.map((block) => {
    if (block?.type !== "chart") return block;
    const resourceId = block.resourceId;
    if (!resourceId) {
      return { ...block, error: "图表块未引用资源", data: null };
    }
    if (!db.isDbReady()) return { ...block, error: "资源库不可用", data: null };
    const row = db.getResource(resourceId);
    if (!row || row.type !== "chart" || !row.payload) {
      return { ...block, error: "图表资源不存在或已被删除", data: null };
    }
    let option;
    try {
      option = JSON.parse(row.payload);
    } catch {
      option = null;
    }
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return { ...block, error: "图表资源不可解析", data: null };
    }
    return { ...block, title: block.title || row.title || null, data: option };
  });
}

export function registerBoardRoutes(ctx) {
  const { app } = ctx;

  // GET /api/boards/:line/copilot — the focused assistant the copilot dock
  // injects for this line (copilot-dock-focused-preset). Same switch as the
  // board, but it never runs the adapter: the dock only needs the preset, and
  // a wire board fetch is four upstream calls.
  app.get("/api/boards/:line/copilot", async (req, res) => {
    if (!lineBoardsEnabled()) {
      return res.status(404).json({
        error: "line_boards_disabled",
        message: "线看板未开启（LINE_BOARDS_ENABLED）",
      });
    }
    const { line } = req.params;
    if (!getBoardAdapter(line)) {
      return res.status(404).json({
        error: "line_not_found",
        message: `该线尚未接入 (${line})`,
        availableLines: listBoardLines(),
      });
    }
    const copilot = await copilotPresetForLine(line);
    return res.json({ line, copilot });
  });

  app.get("/api/boards/:line", async (req, res) => {
    // Deployment switch (add-wire-line-board D8): read per request so flipping
    // the env on a running cell takes effect without a restart in tests/ops.
    if (!lineBoardsEnabled()) {
      return res.status(404).json({
        error: "line_boards_disabled",
        message: "线看板未开启（LINE_BOARDS_ENABLED）",
      });
    }
    const { line } = req.params;
    const adapter = getBoardAdapter(line);

    if (!adapter) {
      // Honest degradation: unknown line → 404 with guidance
      return res.status(404).json({
        error: "line_not_found",
        message: `该线尚未接入 (${line})`,
        availableLines: listBoardLines(),
      });
    }

    try {
      const result = await adapter.fetchBlocks({ email: req.user?.email ?? null });
      // catalog × view (unify-copilot-workbench 2.4). What the adapter returns
      // is the CATALOG; the user's ordered selection is the VIEW. `blocks` stays
      // the merged result so every existing reader (the page's tab derivation,
      // the e2e fixtures, any older client) sees the same shape it always did.
      //
      // No stored view ⇒ resolveView returns the catalog order ⇒ `blocks` is
      // byte-identical to the pre-change response. That is the compatibility
      // contract this task is judged on.
      const catalog = Array.isArray(result?.blocks) ? result.blocks : [];
      const view = storedViewOrNull(db.getPreference, line);
      const merged = resolveView({ userView: view, catalog });
      const blocks = result?.connected === false ? catalog : hydrateChartBlocks(merged.blocks);
      return res.json({
        line: adapter.id,
        title: adapter.title,
        originUrl: adapter.originUrl,
        // Tabs come from what is RENDERED (2.5 aligns the page with this), so a
        // view that hides every block of a tab does not leave an empty tab.
        tabs: tabsOfBlocks(blocks),
        ...result,
        catalog,
        view,
        blocks,
        // Surfaced so the page can say "N 个块已不可用" instead of blocks
        // appearing to vanish on their own (design: silent in data, loud at
        // the surface).
        ...(merged.dropped.length ? { droppedBlocks: merged.dropped } : {}),
      });
    } catch (err) {
      console.error(`[boards/${line}] fetch failed:`, err.message);
      // Per-block errors are rendered by the UI; here we return a single
      // error block that covers the whole board.
      return res.json({
        line: adapter.id,
        title: adapter.title,
        originUrl: adapter.originUrl,
        tabs: [],
        blocks: [
          {
            id: "error",
            type: "metrics",
            title: "加载失败",
            error: err.message || "服务器错误",
          },
        ],
      });
    }
  });
}
