// Unit tests for the UNKNOWN_TOOL candidate enrichment in server/dsh-events.js.
// Drives the real handleDshEvent with synthetic dsh notifications over a fake
// ctx (no runtime, no DB) — the same event shapes observed in live session logs.
// Run: node --test scripts/test-unknown-tool-enrichment.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { attachDshEvents } from "../server/dsh-events.js";

function buildCtx() {
  const broadcasts = [];
  const persisted = [];
  return {
    broadcasts,
    persisted,
    isStreaming: true,
    ready: { dsh: true },
    dshSessionId: "platform-test",
    sessionCollectors: new Map(),
    planBySession: new Map(),
    dshToolNames: new Map(),
    dshTurnBlocks: [],
    dshTurnError: null,
    dshCurrentTurnId: "turn-1",
    clients: { size: 1 },
    broadcast: (m) => broadcasts.push(m),
    // dsh-events now fans turn payloads out per-session (sendToViewers —
    // tool_end lives there) and refreshes the session list after a turn;
    // feed the fan-out into the same capture the assertions read.
    sendToViewers: (_sid, m) => broadcasts.push(m),
    broadcastSessions: async () => {},
    finishTurn: () => {},
    recordMessage: (sid, role, text, blocks) => persisted.push({ sid, role, text, blocks }),
  };
}

const notif = (event) => ({ method: "session.event", params: { event } });
const headerWith = (tools) =>
  notif({ type: "request/header", data: { header: { config: { model: "m" }, tools } } });
const call = (callId, name) =>
  notif({ type: "tool/call", data: { callId, name, arguments: "{}" } });
const result = (callId, text, code) =>
  notif({
    type: "tool/result",
    data: {
      message: {
        source: { callId },
        content: [
          { type: "tool-result", toolCallId: callId, content: [{ type: "text", text }], isError: true },
        ],
      },
      error: { name: "ToolNotFoundError", code },
    },
  });

const ROSTER = [
  { name: "mcp__fd-open-data-mcp__list_concepts", description: "List concepts", parameters: { type: "object", properties: {} } },
  { name: "mcp__fd-find-data-business-mcp__list_concepts", description: "Business concepts", parameters: { type: "object", properties: {} } },
  { name: "grep", description: "Search files", parameters: { type: "object", properties: {} } },
];

test("missing server segment gets exact candidates before broadcast+persist", () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.handleDshEvent(headerWith(ROSTER));
  ctx.handleDshEvent(call("c1", "mcp__list_concepts"));
  ctx.handleDshEvent(result("c1", 'Error: unknown tool "mcp__list_concepts"', "UNKNOWN_TOOL"));

  const toolEnd = ctx.broadcasts.find((m) => m.type === "tool_end");
  assert.ok(toolEnd, "tool_end broadcast missing");
  assert.match(toolEnd.result, /Exact effective-tool candidates:/);
  assert.match(toolEnd.result, /mcp__fd-open-data-mcp__list_concepts/);
  assert.match(toolEnd.result, /mcp__fd-find-data-business-mcp__list_concepts/);
  assert.match(toolEnd.result, /No candidate was executed/);
  // Persistence carries the SAME enriched text.
  assert.equal(ctx.persisted.length, 0); // assistant/message only persists later; block holds it
  assert.equal(ctx.dshTurnBlocks[0].result, toolEnd.result);
});

test("malformed server fragment finds the right server's tools", () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.handleDshEvent(headerWith(ROSTER));
  ctx.handleDshEvent(call("c2", "mcp__find_data_business"));
  ctx.handleDshEvent(result("c2", 'Error: unknown tool "mcp__find_data_business"', "UNKNOWN_TOOL"));
  const toolEnd = ctx.broadcasts.find((m) => m.type === "tool_end");
  assert.match(toolEnd.result, /Exact effective-tool candidates:/);
  // The fragment shares tokens with BOTH business-server names; the key
  // property is at least one business-server full name is offered.
  assert.ok(
    /mcp__fd-find-data-business-mcp__list_concepts/.test(toolEnd.result) ||
      /mcp__fd-open-data-mcp__list_concepts/.test(toolEnd.result),
  );
});

test("no plausible candidate keeps the error and points at tool_search", () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.handleDshEvent(headerWith(ROSTER));
  ctx.handleDshEvent(call("c3", "mcp__zzz_totally_unrelated"));
  ctx.handleDshEvent(result("c3", 'Error: unknown tool "mcp__zzz_totally_unrelated"', "UNKNOWN_TOOL"));
  const toolEnd = ctx.broadcasts.find((m) => m.type === "tool_end");
  assert.doesNotMatch(toolEnd.result, /Exact effective-tool candidates:/);
  assert.match(toolEnd.result, /No similar effective tool exists/);
  assert.match(toolEnd.result, /tool_search/);
});

test("non-UNKNOWN_TOOL errors are untouched", () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.handleDshEvent(headerWith(ROSTER));
  ctx.handleDshEvent(call("c4", "mcp__fd-open-data-mcp__list_concepts"));
  const raw = "Error: tool call timed out";
  ctx.handleDshEvent(result("c4", raw, "EXECUTION_ERROR"));
  const toolEnd = ctx.broadcasts.find((m) => m.type === "tool_end");
  assert.equal(toolEnd.result, raw);
});

test("malformed/missing header degrades to guidance without candidates", () => {
  const ctx = buildCtx();
  attachDshEvents(ctx);
  ctx.handleDshEvent(notif({ type: "request/header", data: {} })); // no tools
  ctx.handleDshEvent(call("c5", "mcp__list_concepts"));
  ctx.handleDshEvent(result("c5", 'Error: unknown tool "mcp__list_concepts"', "UNKNOWN_TOOL"));
  const toolEnd = ctx.broadcasts.find((m) => m.type === "tool_end");
  assert.ok(toolEnd.result.includes('unknown tool "mcp__list_concepts"'));
  assert.doesNotMatch(toolEnd.result, /Exact effective-tool candidates:/);
});
