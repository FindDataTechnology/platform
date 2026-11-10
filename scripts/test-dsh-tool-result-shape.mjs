// Unit tests — tool/result shape tolerance (copilot-dock-focused-preset D9).
// Run: node --test scripts/test-dsh-tool-result-shape.mjs
//
// Production dsh emits the FLAT tool/result shape — message.content is the MCP
// content array and isError sits beside it — while every reader assumed the
// WRAPPER shape (message.content[0] = { toolCallId, isError, content: [...] })
// the unit fixtures carried. On a prod cell 704/704 recorded events were flat
// (2026-10-22): live tool output, persisted results and the tool-layer 401
// staling had been silently empty, and the action-gate's confirmation card
// (which reads the proposal from the result text) could never fill in.
//
//   1.x  parseToolResult: both shapes → same callId / text / isError; no text
//        blocks → null; garbage → null without throwing.
//   2.x  dsh-events on the FLAT shape: tool_end carries the result text and
//        the error flag; a flat 401 still attaches the connect pointer; the
//        persisted block holds the text.
//   3.x  cron-runner's collector on the FLAT shape keeps the result text.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A baseline mcp.json so the 401 hint can map the failing server to its
// credential panel (same seeding as test-connect-guidance).
const dir = mkdtempSync(path.join(os.tmpdir(), "tool-result-shape-"));
const mcpPath = path.join(dir, "mcp.json");
writeFileSync(
  mcpPath,
  JSON.stringify({ mcpServers: { market: { type: "http", url: "https://registry.example/mcp", credentialRef: "registry" } } }),
);
process.env.MCP_CONFIG_PATH = mcpPath;

const { parseToolResult } = await import("../server/dsh-events.js");

const PROPOSAL = JSON.stringify({ proposalId: "p1", state: "pending", impact: "将包「x」可见性改为 private", risk: "write" });

const flat = (text, { callId = "c1", isError = false } = {}) => ({
  data: { message: { source: { kind: "tool", callId }, content: [{ type: "text", text }], isError, id: "msg-1" } },
});
const wrapper = (text, { callId = "c1", isError = false } = {}) => ({
  data: { message: { source: { callId }, content: [{ toolCallId: callId, isError, content: [{ type: "text", text }] }] } },
});

test("1.1 flat and wrapper shapes parse to the same callId, text and error flag", () => {
  for (const mk of [flat, wrapper]) {
    const ok = parseToolResult(mk(PROPOSAL));
    assert.equal(ok.callId, "c1");
    assert.equal(ok.resultText, PROPOSAL);
    assert.equal(ok.isError, false);
    assert.ok(Array.isArray(ok.resultBlocks));
    const bad = parseToolResult(mk("Error: 401 Unauthorized", { isError: true }));
    assert.equal(bad.isError, true);
    assert.equal(bad.resultText, "Error: 401 Unauthorized");
  }
});

test("1.2 multiple text blocks join; non-text blocks are skipped; none → null", () => {
  const ev = { data: { message: { source: { callId: "c2" }, content: [{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }] } } };
  assert.equal(parseToolResult(ev).resultText, "ab");
  const none = { data: { message: { source: { callId: "c3" }, content: [{ type: "image", data: "…" }] } } };
  assert.equal(parseToolResult(none).resultText, null);
  assert.equal(parseToolResult(none).callId, "c3");
});

test("1.3 garbage never throws", () => {
  for (const ev of [null, undefined, {}, { data: {} }, { data: { message: {} } }, { data: { message: { content: "x" } } }, { data: { error: { code: "X" } } }]) {
    const r = parseToolResult(ev);
    assert.equal(r.resultText, null);
    assert.equal(r.resultBlocks, null);
  }
  assert.equal(parseToolResult({ data: { error: { code: "X" } } }).isError, true);
});

// ── 2.x dsh-events end to end on the flat shape ─────────────────────────────

async function harness() {
  const { createAppContext } = await import("../server/context.js");
  const { attachDshEvents } = await import("../server/dsh-events.js");
  const SESSION = "platform-web-flat";
  const ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = SESSION;
  ctx.webTurnSessions = new Set([SESSION]);
  const sent = [];
  ctx.broadcast = (m) => sent.push(m);
  ctx.sendToViewers = (_sid, m) => sent.push(m);
  const notify = (type, data) =>
    ctx.handleDshEvent({ method: "session.event", params: { sessionId: SESSION, event: { type, seq: 1, time: 1, data } } });
  return { ctx, sent, notify, SESSION };
}

test("2.1 flat success: tool_end carries the proposal text and the persisted block holds it", async () => {
  const { ctx, sent, notify, SESSION } = await harness();
  notify("tool/call", { callId: "c1", name: "mcp__actions__propose_action", arguments: JSON.stringify({ actionId: "facet.pack.visibility", args: { id: "x" } }) });
  notify("tool/result", flat(PROPOSAL).data);
  const end = sent.find((m) => m.type === "tool_end");
  assert.ok(end, "tool_end emitted");
  assert.equal(end.toolCallId, "c1");
  assert.equal(end.result, PROPOSAL);
  assert.equal(end.isError, false);
  assert.equal(ctx.turnStateFor(SESSION).blocks.find((b) => b.id === "c1")?.result, PROPOSAL);
});

test("2.2 flat 401: error flag, text untouched, connect pointer attached", async () => {
  const { sent, notify } = await harness();
  notify("tool/call", { callId: "c1", name: "mcp__market__search", arguments: "{}" });
  notify("tool/result", flat("Error: 401 Unauthorized", { isError: true }).data);
  const end = sent.find((m) => m.type === "tool_end");
  assert.ok(end);
  assert.equal(end.isError, true);
  assert.equal(end.result, "Error: 401 Unauthorized");
  assert.deepEqual(end.connect, { panel: "registry" });
});

// ── 3.x cron-runner collector ───────────────────────────────────────────────

test("3.1 cron collector keeps the flat result text on the tool block", async () => {
  // The collector is wired through ctx.sessionCollectors inside runCronTurn;
  // exercise the same parse the collector now uses, against the flat event.
  const r = parseToolResult({ data: flat("cron result").data });
  assert.equal(r.callId, "c1");
  assert.equal(r.resultText, "cron result");
});
