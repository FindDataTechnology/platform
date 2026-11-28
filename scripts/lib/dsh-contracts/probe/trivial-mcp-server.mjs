#!/usr/bin/env node
// scripts/lib/dsh-contracts/probe/trivial-mcp-server.mjs — the local stdio MCP
// server contract ⑭ composes once per child process: it answers initialize and
// tools/list with a single `ping` tool and nothing else. Its PROCESS COUNT is
// the contract's subject (one per dsh process, however many agents consume it),
// so the body stays deliberately trivial — no deps, newline-delimited
// JSON-RPC 2.0, exits on stdin end.
//
// Loaded only inside the contracts runner's throwaway profile; never shipped in
// the image. No @deepseek-ai/* imports (kept off the adapter list by design).

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const TOOL = { name: "ping", description: "contracts trivial MCP probe tool", inputSchema: { type: "object", properties: {} } };

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // a non-JSON line is not ours to answer
  }
  if (msg.method === "initialize") {
    send(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "contracts-trivial-mcp", version: "0.0.0" },
    });
  } else if (msg.method === "tools/list") {
    send(msg.id, { tools: [TOOL] });
  } else if (msg.method === "tools/call") {
    send(msg.id, { content: [{ type: "text", text: "pong" }], isError: false });
  } else if (msg.id !== undefined) {
    send(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
  }
  // Notifications (initialized/, cancelled) need no answer.
});
rl.on("close", () => process.exit(0));

function send(id, result, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
}
