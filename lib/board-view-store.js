// ── Board view store (unify-copilot-workbench 2.8) ──────────────────────────
//
// The write side of catalog × view. Two verbs, both reached ONLY through the
// action gate (an approved `board.view.set` / `board.view.reset` proposal);
// nothing else may call them. That is why there is no REST route here: a
// direct PUT would be the second write path the action-gate spec forbids.
//
// OWNERSHIP: `user_preferences` is this CELL's table, and a hosted cell belongs
// to exactly one user (or, on a desktop / single-user deployment, to the
// machine owner). So "the acting user's own view" is the whole table — there is
// no cross-user target to validate against, and none can be named: the args
// carry a LINE, never an email. A proposal that tries to name another user has
// nowhere to put that name.
//
// What a view may contain is already constrained by storedViewOrNull()
// (max block count, blockId/resourceId shape); this module's job is to make the
// write SAFE and HONEST: cap it, reject a shape that cannot render, and tell
// the caller exactly what changed so the board can refresh only that line.

import * as db from "../db.js";
import { MAX_VIEW_BLOCKS, listBoardLines } from "./board-adapters.js";

// The executor's own error class lives in action-executor.js, but importing it
// from here would be a cycle (the executor imports this module lazily for the
// handlers). So these carry the same `code` contract without the class: the
// executor wraps anything that reaches it, and routes/actions.js maps the code
// either way. Keeping the shape identical is what makes that work.
class ViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
  }
}

const LINE_VIEW_PREFIX = "board.view.";

function assertLine(line) {
  const value = typeof line === "string" ? line.trim() : "";
  if (!value) throw new ViewError("invalid_args", "缺少看板线（line）");
  if (!listBoardLines().includes(value)) {
    throw new ViewError("invalid_args", `未知的看板线：${value}（可用：${listBoardLines().join(", ")}）`);
  }
  return value;
}

/** Normalize + validate one view entry. Throws on anything that cannot render. */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    throw new ViewError("invalid_args", `视图第 ${index + 1} 项不是对象`);
  }
  const blockId = typeof entry.blockId === "string" ? entry.blockId.trim() : "";
  if (!blockId) throw new ViewError("invalid_args", `视图第 ${index + 1} 项缺少 blockId`);
  const resourceId = typeof entry.resourceId === "string" && entry.resourceId ? entry.resourceId : null;
  const tab = typeof entry.tab === "string" && entry.tab ? entry.tab : null;
  return {
    blockId,
    tab,
    order: Number.isFinite(entry.order) ? Number(entry.order) : index,
    ...(resourceId ? { resourceId } : {}),
    ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
  };
}

/**
 * Apply an ordered view for one line.
 * `args.view` empty ⇒ reset (same as the reset verb). Both are exposed so the
 * confirmation card can describe the user's real intent.
 */
export async function applyBoardView({ args, email }) {
  if (!db.isDbReady()) throw new ViewError("storage_unavailable", "本 cell 的偏好存储不可用");
  const line = assertLine(args?.line);
  const raw = Array.isArray(args?.view) ? args.view : null;
  if (!raw) throw new ViewError("invalid_args", "缺少 view（块引用数组）");
  if (raw.length === 0) return resetBoardView({ args, email });
  if (raw.length > MAX_VIEW_BLOCKS) {
    throw new ViewError(
      "invalid_args",
      `视图最多 ${MAX_VIEW_BLOCKS} 个块（收到 ${raw.length}）——再多就没人读了，而且每次打开都要逐块取数`,
    );
  }
  const view = raw.map(normalizeEntry);
  // Dupes render once; keep the FIRST occurrence so "the order I said" wins.
  const seen = new Set();
  const deduped = view.filter((e) => (seen.has(e.blockId) ? false : (seen.add(e.blockId), true)));

  db.setPreference(`${LINE_VIEW_PREFIX}${line}`, JSON.stringify(deduped));
  return {
    summary: `已更新「${line}」看板视图：${deduped.length} 个块`,
    changed: { line, view: deduped },
  };
}

/** Clear the stored view so the line renders its default again. */
export async function resetBoardView({ args }) {
  if (!db.isDbReady()) throw new ViewError("storage_unavailable", "本 cell 的偏好存储不可用");
  const line = assertLine(args?.line);
  db.setPreference(`${LINE_VIEW_PREFIX}${line}`, null);
  return { summary: `已把「${line}」看板视图恢复为默认`, changed: { line, view: null } };
}
