// Hermetic tests for the handoff MCP tool (chatwoot-ai-handoff 4.1/4.2).
//
// The point: the agent's own exit for "I cannot answer this". Two properties
// matter more than the plumbing and are pinned here —
//   1. no bot identity injected ⇒ an EXPLAINABLE failure, never a silent no-op
//      and never a request that is guaranteed to be refused;
//   2. a platform verdict (ok:false with a failure class) reaches the model as
//      DATA, so it can say the honest thing to the visitor instead of pretending
//      the handoff worked.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server/handoff-mcp.js";

// Drive the server's CallTool handler directly — same seam the MCP transport
// uses, without standing up stdio.
function callTool(server, name, args) {
  const handlers = server._requestHandlers;
  const h = handlers.get("tools/call");
  return h({ method: "tools/call", params: { name, arguments: args } });
}

function fakeDriver(result) {
  const calls = [];
  const factory = ({ botId, sessionId }) => {
    calls.push({ botId, sessionId });
    return {
      async handoff(args) {
        calls.push({ args });
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };
  factory.calls = calls;
  return factory;
}

test("handoff: no injected bot identity is an explainable failure, not a call", async () => {
  const driver = fakeDriver({ ok: true });
  const server = await createServer({ identity: () => ({ botId: null, sessionId: null }), driverFactory: driver });
  const r = await callTool(server, "handoff_to_human", { reason: "visitor_asked" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no bot identity was injected/);
  assert.equal(driver.calls.length, 0, "must not fire a request that cannot succeed");
});

test("handoff: a successful handoff is returned to the model as data", async () => {
  const driver = fakeDriver({ ok: true, status: "open", assigneeId: 5 });
  const server = await createServer({
    identity: () => ({ botId: "bot-1", sessionId: "bot-bot-1-abc" }),
    driverFactory: driver,
  });
  const r = await callTool(server, "handoff_to_human", { reason: "cannot_answer", note: "问报价" });
  assert.ok(!r.isError);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, status: "open", assigneeId: 5 });
  // The chatKey came from the injected identity, not from the model.
  assert.deepEqual(driver.calls[0], { botId: "bot-1", sessionId: "bot-bot-1-abc" });
});

test("handoff: a platform verdict (ok:false) reaches the model, not swallowed", async () => {
  const driver = fakeDriver({ ok: false, failure: "target-unavailable", detail: "422" });
  const server = await createServer({
    identity: () => ({ botId: "bot-1", sessionId: "bot-bot-1-abc" }),
    driverFactory: driver,
  });
  const r = await callTool(server, "handoff_to_human", { reason: "beyond_authority" });
  assert.ok(!r.isError, "a verdict is an outcome, not a tool error");
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.failure, "target-unavailable");
});

test("handoff: a transport throw surfaces as a tool error", async () => {
  const driver = fakeDriver(new Error("ECONNREFUSED"));
  const server = await createServer({
    identity: () => ({ botId: "bot-1", sessionId: "bot-bot-1-abc" }),
    driverFactory: driver,
  });
  const r = await callTool(server, "handoff_to_human", { reason: "visitor_asked" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /handoff failed: ECONNREFUSED/);
});

test("handoff: an unknown tool name is refused", async () => {
  const server = await createServer({ identity: () => ({ botId: "b", sessionId: "s" }) });
  const r = await callTool(server, "escalate_someone_else", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown tool/);
});

test("handoff: the tool declares the three deterministic reasons", async () => {
  const server = await createServer({ identity: () => ({}) });
  const h = server._requestHandlers.get("tools/list");
  const { tools } = await h({ method: "tools/list" });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "handoff_to_human");
  assert.deepEqual(
    tools[0].inputSchema.properties.reason.enum,
    ["cannot_answer", "visitor_asked", "beyond_authority"],
  );
});