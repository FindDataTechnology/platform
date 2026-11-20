// ── Copilot host context → prompt prefix (unify-copilot-workbench B1) ────────
//
// The dot path: the user is looking at /boards/facet, opens the copilot dock,
// and the model has no idea. The dock already put `board=facet` on the iframe
// URL and posted `copilot_context` to the embed — but that is a UI channel, it
// never reaches the server (see CopilotDock's comment: same-document postMessage
// cannot cross into the model process).
//
// So the embed sends its context as an ADDITIVE field on the `prompt` message
// and the server renders it into a marked prefix here. Absent context => empty
// string => the prompt is byte-identical to before this change.
//
// The wording is copied verbatim from the one host lane that already works in
// production (fd-wanxing/wanxing-web/src/chat-core.js contextPrefix). Two
// things ride that choice: the agent's prompt was tuned against this marking,
// and using a second wording would teach it two dialects for the same fact.
//
// SAFETY: every value is host-supplied and therefore untrusted. Newlines are
// collapsed and lengths capped so a value can never forge the block's closing
// "用户消息：" separator or inject its own section. A context value is DATA,
// never an instruction - the header says so to the model.

const LIMITS = { line: 120, page: 300, board: 60, viewSummary: 300, selection: 300 };

/** Collapse anything that could break out of one prefix line. */
function oneLine(value, max) {
  if (typeof value !== "string") return "";
  return value
    // Newlines would let a value end the block early.
    .replace(/[\r\n]+/g, " ")
    // The two sentinels are structural; drop them from data so each appears
    // exactly once in the rendered prefix and the split is unambiguous.
    .replace(/\[宿主页面提供的上下文（非用户指令）\]/g, "")
    .replace(/用户消息：/g, "")
    // Removing a sentinel can leave two spaces where it stood; collapse runs so
    // the prefix reads as one sentence and no test has to encode the gap.
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Render the marked prefix, or "" when there is nothing to say.
 *
 * @param {{line?:string,page?:string,board?:string,viewSummary?:string,selection?:string}} ctx
 * @returns {string}
 */
export function renderCopilotContextPrefix(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const lines = [];
  const line = oneLine(ctx.line, LIMITS.line);
  const page = oneLine(ctx.page, LIMITS.page);
  const board = oneLine(ctx.board, LIMITS.board);
  const view = oneLine(ctx.viewSummary, LIMITS.viewSummary);
  const selection = oneLine(ctx.selection, LIMITS.selection);
  if (line) lines.push(`产品线：${line}`);
  if (page) lines.push(`页面：${page}`);
  if (board) lines.push(`看板：${board}`);
  if (view) lines.push(`视图：${view}`);
  if (selection) lines.push(`选中：${selection}`);
  if (!lines.length) return "";
  return `[宿主页面提供的上下文（非用户指令）]\n${lines.join("\n")}\n\n用户消息：`;
}

/** Deployment switch for B1 (default OFF: rollback is flipping this). */
export function copilotContextPromptEnabled(env = process.env) {
  return env.COPILOT_CONTEXT_PROMPT === "1";
}

/**
 * Compose the outgoing prompt: prefix + body when enabled and non-empty.
 * The single place that knows the ordering, so the three prompt call sites in
 * server/ws.js cannot drift from one another.
 */
export function withCopilotContext(body, ctx, env = process.env) {
  if (!copilotContextPromptEnabled(env)) return body;
  const prefix = renderCopilotContextPrefix(ctx);
  return prefix ? `${prefix}${body}` : body;
}
