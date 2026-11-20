// chat-connect-guidance — classification table + attach-point contract.
//
//   node --test scripts/test-connect-guidance.mjs
//
// turnErrorHint/toolFailureHint are pure over text + the failing tool's server
// config; the mcp.json baseline is a temp file so the DB path (no DB in this
// process) falls through exactly like a fresh deployment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "connect-guidance-"));
const mcpPath = path.join(dir, "mcp.json");
writeFileSync(
  mcpPath,
  JSON.stringify({
    mcpServers: {
      market: { type: "http", url: "https://registry.example/mcp", credentialRef: "registry" },
      facet: { type: "http", url: "https://facet.example/mcp", credentialRef: "facet-market" },
      caller: { type: "http", url: "https://wanxing.example/mcp", credentialRef: "wanxing-caller" },
      plain: { type: "http", url: "https://public.example/mcp" },
    },
  }),
);
process.env.MCP_CONFIG_PATH = mcpPath;
process.env.DB_PATH = path.join(dir, "unit.db");

const { turnErrorHint, toolFailureHint } = await import("../server/connect-guidance.js");

// ── model lane ──────────────────────────────────────────────────────────────

test("model-lane credential failures point at the 词元 card", () => {
  for (const msg of [
    "401 Unauthorized",
    "Error: 403 Forbidden",
    "Incorrect API key provided: sk-abc",
    "invalid_api_key: Invalid API key",
    "AuthenticationError: authentication failed",
    "Missing API key for provider",
    "鉴权失败：密钥无效",
    "credential rejected by upstream",
  ]) {
    assert.deepEqual(turnErrorHint(msg), { panel: "ciyuan-account" }, msg);
  }
});

test("non-credential model-lane failures carry no hint", () => {
  for (const msg of [
    "LLM request failed",
    "The agent turn failed",
    "429 Too Many Requests",
    "fetch failed: ECONNRESET",
    "context length exceeded (4096 tokens)",
    "500 Internal Server Error",
    "",
    null,
    undefined,
  ]) {
    assert.equal(turnErrorHint(msg), null, String(msg));
  }
});

// ── MCP tools ───────────────────────────────────────────────────────────────

test("a failed mcp tool maps through its server's credentialRef to the ref's panel", () => {
  assert.deepEqual(toolFailureHint("mcp__market__search", "Error: 401 Unauthorized"), { panel: "registry" });
  assert.deepEqual(toolFailureHint("mcp__facet__list", "HTTP 401: unauthorized"), { panel: "facet-market" });
  // wanxing-caller is served by the 词元 account key (ciyuan-account-lane): its
  // panel is the 词元 card, not a legacy caller card.
  assert.deepEqual(toolFailureHint("mcp__caller__call", "Error: invalid api key"), { panel: "ciyuan-account" });
});

test("servers without a credentialRef, unknown servers and bare tools carry no hint", () => {
  assert.equal(toolFailureHint("mcp__plain__ping", "401 Unauthorized"), null);
  assert.equal(toolFailureHint("mcp__nobody__ping", "401 Unauthorized"), null);
  assert.equal(toolFailureHint("read_file", "401 Unauthorized"), null);
  assert.equal(toolFailureHint("tool_search", "credential missing"), null);
});

test("non-credential tool failures carry no hint even on a ref-bearing server", () => {
  assert.equal(toolFailureHint("mcp__market__search", "Error: upstream timeout"), null);
  assert.equal(toolFailureHint("mcp__market__search", "Error: unknown tool \"search\""), null);
  assert.equal(toolFailureHint("mcp__market__search", ""), null);
  assert.equal(toolFailureHint("mcp__market__search", null), null);
});

// ── attach-point contract (dsh-events) ──────────────────────────────────────

test("dsh-events attaches connect to the turn error and the failed tool_end, text untouched", async () => {
  const { createAppContext } = await import("../server/context.js");
  const { attachDshEvents } = await import("../server/dsh-events.js");
  const SESSION = "platform-web-1";
  const ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = SESSION;
  ctx.webTurnSessions = new Set([SESSION]);
  const sent = [];
  ctx.broadcast = (m) => sent.push(m);
  ctx.sendToViewers = (_sid, m) => sent.push(m);
  const sessionEvent = (type, data) =>
    ({ method: "session.event", params: { sessionId: SESSION, event: { type, seq: 1, time: 1, data } } });
  const notify = (type, data) => ctx.handleDshEvent(sessionEvent(type, data));

  const T = ctx.turnStateFor(SESSION);
  notify("tool/call", { callId: "c1", name: "mcp__market__search", arguments: "{}" });
  notify("tool/result", {
    message: { source: { callId: "c1" }, content: [{ toolCallId: "c1", isError: true, content: [{ type: "text", text: "Error: 401 Unauthorized" }] }] },
  });
  const toolEnd = sent.find((m) => m.type === "tool_end");
  assert.ok(toolEnd, "tool_end emitted");
  assert.equal(toolEnd.isError, true);
  assert.equal(toolEnd.result, "Error: 401 Unauthorized", "result text is byte-identical");
  assert.deepEqual(toolEnd.connect, { panel: "registry" });
  assert.equal(T.blocks.find((b) => b.id === "c1")?.connect, undefined, "persisted block carries no pointer");

  notify("turn/end", { reason: { kind: "error", error: { message: "Incorrect API key provided" } } });
  const err = sent.find((m) => m.type === "error");
  assert.ok(err, "error emitted");
  assert.equal(err.message, "Incorrect API key provided");
  assert.deepEqual(err.connect, { panel: "ciyuan-account" });

  sent.length = 0;
  ctx.turnStateFor(SESSION).error = "fetch failed";
  notify("turn/end", { reason: { kind: "error" } });
  const bare = sent.find((m) => m.type === "error");
  assert.ok(bare, "error emitted");
  assert.equal(bare.connect, undefined, "network failure: no pointer");
});
