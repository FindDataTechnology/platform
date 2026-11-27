// Tool-post turn executor (add-tool-posts, agent-fleet-core).
//
// The T1 tier of the member model: a post whose turn is ONE deterministic MCP
// tool call — no dsh runtime, no preset switch, no LLM, zero tokens. The
// cadence's promptTemplate IS the tool's JSON arguments. Transport reuses the
// action-executor's building blocks verbatim: operator stdio servers (bundle
// manifest / mcp.json, the same children the profile spawns) take the stdio
// path; registry catalog servers take the HTTP path with the cell owner's
// live credential for the server's declared ref — the same bearer the user's
// own pack presents. Every failure keeps its honest cause; results land in
// the task session like any other turn so O1's seam records them unchanged.

import * as chatHistory from "../chat-history.js";
import {
  resolveServerEndpoint,
  resolveStdioServerConfig,
  callStdioTool,
  callLineTool,
  classifyToolResult,
  marketEntryFor,
} from "../lib/action-executor.js";
import { credentialRefForEntry, liveTokenForRef } from "../credential-refs.js";

export const TOOL_TARGET_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)::([A-Za-z0-9][A-Za-z0-9._-]*)$/;

// Split "server::tool" — null when the shape is wrong.
export function splitToolTarget(targetId) {
  const m = TOOL_TARGET_RE.exec(String(targetId ?? ""));
  return m ? { server: m[1], tool: m[2] } : null;
}

export async function runToolTurn(ctx, job, timeoutMs, deps = {}) {
  const {
    resolveStdio = resolveStdioServerConfig,
    resolveEndpoint = resolveServerEndpoint,
    stdioCall = callStdioTool,
    lineCall = callLineTool,
  } = deps;

  const fail = (error) => {
    const sessionId = job.sessionId || `task-${job.id}`;
    chatHistory.recordMessage(sessionId, "assistant", JSON.stringify({ ok: false, error }));
    return { ok: false, error };
  };

  // The arguments must be a JSON object — this is the tool's contract, not a
  // prompt. Anything else is a misconfigured post, reported as-is.
  let args = null;
  try {
    args = JSON.parse(job.prompt ?? "");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
  } catch {
    return fail("tool post promptTemplate must be a JSON object — it is the tool's arguments (e.g. {\"query\":\"…\"})");
  }

  const target = splitToolTarget(job.preset);
  if (!target) {
    return fail(`tool target '${job.preset}' must be 'server::tool'`);
  }
  const sessionId = job.sessionId || `task-${job.id}`;
  chatHistory.recordMessage(sessionId, "user", job.prompt);
  if (job.sessionTitle) {
    try { chatHistory.setTitle(sessionId, job.sessionTitle); } catch { /* prompt-derived title stays */ }
  }

  let result;
  try {
    const stdioConfig = resolveStdio(target.server);
    if (stdioConfig) {
      result = await stdioCall({ stdioConfig, toolName: target.tool, args, timeoutMs });
    } else {
      const endpoint = resolveEndpoint(target.server);
      if (!endpoint) {
        return fail(`tool server '${target.server}' is not routable — no registry entry, no stdio config`);
      }
      // The same bearer the user's own pack presents for this server; no
      // live credential is an honest failure naming the ref.
      const entry = marketEntryFor(target.server);
      const ref = entry ? credentialRefForEntry(entry) : null;
      const bearer = ref ? liveTokenForRef(ref, ctx?.cellUserEmail ?? null) : null;
      if (!bearer) {
        return fail(`tool server '${target.server}' needs credential ref '${ref ?? "unknown"}' — no live token for this cell owner`);
      }
      result = await lineCall({ endpoint, toolName: target.tool, args, bearer, timeoutMs });
    }
  } catch (e) {
    return fail(`tool call failed: ${e?.message || e}`);
  }

  const cls = classifyToolResult(result);
  const text = cls.ok ? JSON.stringify(result?.content ?? result ?? {}) : cls.text;
  chatHistory.recordMessage(sessionId, "assistant", text);
  return cls.ok ? { ok: true, text } : { ok: false, error: cls.text || "tool reported an error" };
}
