// ── Board routes (add-line-boards-and-action-gate, task 10) ─────────────────
//
// GET /api/boards/:line — fetch a board's blocks
// Returns { line, title, originUrl, tabs, blocks: [...] } where `tabs` is the
// de-duplicated, first-appearance-ordered set of `tab` values the adapter's
// own blocks declare, and each block has { id, type, title, data?, error? }.
//
// `tabs` is derived here, never declared separately (unify-line-board-tabs D1):
// a front-end table and an adapter list are two sources that drift silently —
// lex's four tabs were shipped by the adapter and never reached the page.
//
// Unknown lines return 404 with an honest message.

import { getBoardAdapter, listBoardLines, lineBoardsEnabled, tabsOfBlocks } from "../../lib/board-adapters.js";
import { copilotPresetForLine } from "../../lib/copilot-presets.js";

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
      return res.json({
        line: adapter.id,
        title: adapter.title,
        originUrl: adapter.originUrl,
        tabs: tabsOfBlocks(result.blocks ?? []),
        ...result,
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
