#!/usr/bin/env node
// fake-acp-agent.mjs — a minimal ACP-speaking agent over stdio (add-harness-adapter
// task 2.2). Test-only fixture shared by the adapter unit suite and contract ⑰:
// no network, no credentials, deterministic replies.
//
// Implements exactly the ACP surface the adapter maps (design D4):
//   initialize → agentCapabilities
//   session/new {cwd, mcpServers} → sessionId (absolute cwd required — the
//     adapter must send one; a relative path answers an error, the shape the
//     real agents enforce via validateWorkspaceParams). The mcpServers array
//     is recorded per session and echoed into that session's first reply
//     (` mcp=<JSON>`) — the contract suite's pin that per-deployment MCP
//     references actually reached the wire (add-harness-materializer 2.1).
//   session/set_config_option {configId:"model", value: JSON.stringify([provider,model])}
//   session/prompt → streamed session/update notifications (agent_message_chunk)
//     + usage_update, ending with stopReason "end_turn"
//   session/cancel (notification) → the parked prompt answers stopReason "cancelled"
//   session/resume → resumes a known session id (mode-dependent)
//
// Modes (--mode=):
//   normal  (default) — replies FAKE_ACP_REPLY, streams two chunks, emits usage_update
//   empty   — ends the turn with no assistant text (the empty-turn failure family)
//   nope    — exits immediately (the cold-start failure family)
//   noresume— session/resume answers an error (an ACP agent without resume support)

import { createInterface } from "node:readline";

const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=normal").slice("--mode=".length);
const REPLY = process.env.FAKE_ACP_REPLY || "fake acp ok";
// How long a prompt stays parked before answering itself. The cancel test
// widens it so the cancel always arrives while the prompt is still parked —
// with the 10ms default a slow session/new could let the turn finish first
// and the test would read as a cancel defect under load.
const PARK_MS = Number(process.env.FAKE_ACP_PARK_MS) > 0 ? Number(process.env.FAKE_ACP_PARK_MS) : 10;

if (mode === "nope") {
  // A binary that cannot come up: no handshake, immediate exit.
  process.exit(3);
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sessions = new Map(); // sessionId → { cwd, model }
const parked = new Map(); // requestId → resolve

let nextSession = 0;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // A notification (no id): the only one the adapter sends is session/cancel.
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      const p = parked.get(msg.params?.sessionId);
      if (p) {
        parked.delete(msg.params?.sessionId);
        p("cancelled");
      }
    }
    return;
  }
  void handle(msg).catch((e) => {
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } });
  });
});

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      out({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: mode !== "noresume" } } });
      return;
    case "session/new": {
      const cwd = params?.cwd;
      // The adapter must send an absolute cwd (the real agents reject relatives).
      if (typeof cwd !== "string" || !cwd.startsWith("/")) {
        out({ jsonrpc: "2.0", id, error: { code: -32602, message: "cwd must be an absolute path" } });
        return;
      }
      const sessionId = `fake-session-${nextSession++}`;
      sessions.set(sessionId, { cwd, model: null, mcp: Array.isArray(params?.mcpServers) ? params.mcpServers : null });
      out({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }
    case "session/resume": {
      const sessionId = params?.sessionId;
      if (mode === "noresume" || !sessions.has(sessionId)) {
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: `unknown session ${sessionId}` } });
        return;
      }
      out({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    case "session/set_config_option": {
      const session = sessions.get(params?.sessionId);
      if (!session) {
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: "unknown session" } });
        return;
      }
      if (params?.configId === "model") {
        try {
          session.model = JSON.parse(params.value);
        } catch {
          out({ jsonrpc: "2.0", id, error: { code: -32602, message: "model value must be JSON [provider, model]" } });
          return;
        }
      }
      out({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    case "session/prompt": {
      const session = sessions.get(params?.sessionId);
      if (!session) {
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: "unknown session" } });
        return;
      }
      const sessionId = params.sessionId;
      // Park until answered (cancel) or immediately stream the reply.
      const stopReason = await new Promise((resolve) => {
        parked.set(sessionId, resolve);
        if (mode === "empty") {
          // No assistant text at all: end the turn right away.
          parked.delete(sessionId);
          resolve("end_turn");
          return;
        }
        setTimeout(() => {
          if (!parked.has(sessionId)) return; // already cancelled
          parked.delete(sessionId);
          const modelTag = session.model ? ` [${session.model[1]}]` : "";
          const mcpTag = Array.isArray(session.mcp) && session.mcp.length ? ` mcp=${JSON.stringify(session.mcp)}` : "";
          const text = `${REPLY}${modelTag}${mcpTag}`;
          const mid = Math.ceil(text.length / 2);
          for (const piece of [text.slice(0, mid), text.slice(mid)]) {
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } } } });
          }
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", inputTokens: 120, outputTokens: 30 } } });
          resolve("end_turn");
        }, PARK_MS);
      });
      out({ jsonrpc: "2.0", id, result: { stopReason } });
      return;
    }
    default:
      out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
