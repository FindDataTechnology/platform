// adopt-yongyi-client-sdk task 3 — the runner consumes the memory通用件 from
// @finddatatechnology/yongyi-client now. Kept here: the runner-kept piece
// (memory-capture.js — /capture batch queue client, NOT an SDK surface),
// the compose seams (compose-acp / compose) that take the SDK discipline
// text and mount rows as inputs, and the harness event mappers. The mount
// row builders and the discipline constant are asserted against the SDK
// exports; SDK-internal behavior is the SDK suite's job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCapture, compactJsonText } from "../memory-capture.js";
import { materializeAcpWorkspace, acpMcpServers } from "../compose-acp.js";
import { materializePackHome } from "../compose.js";
import { dshToolEvent } from "../harness/dsh.js";
import { acpToolEvent } from "../harness/acp.js";
import * as YongYi from "@finddatatechnology/yongyi-client";

const { MEMORY_DISCIPLINE } = YongYi;

// ── SDK mounts availability ─────────────────────────────────────────────────
// The mount builders moved into the SDK (adopt-yongyi-client-sdk task 0.1),
// but the PUBLISHED 0.1.1 shipped a stale dist without the mounts module
// (fd-memory/sdk/src/mounts.ts exists; sdk/dist was not rebuilt before
// npm publish). Until a rebuilt 0.1.2 lands, the four shape tests below
// skip with an explicit reason and re-activate automatically on install.
const MOUNT_EXPORTS = ["memoryNamespaceFor", "podMemoryNamespace", "dshMemoryMount", "acpMemoryMount"];
const mountExportNames = new Set(
  Object.entries(YongYi)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name),
);
const missingMountExports = MOUNT_EXPORTS.filter((name) => !mountExportNames.has(name));
const mountsSkip = missingMountExports.length
  ? `SDK 0.1.1 published a stale dist without the mounts module (missing: ${missingMountExports.join(", ")}) — fd-memory/sdk needs a rebuild + 0.1.2 publish + npm install; these shape assertions activate automatically then`
  : false;

function fakeOk() {
  const seen = [];
  return {
    seen,
    impl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200 };
    },
  };
}

test("MemoryCapture flushes a batch with runner namespace and bearer token", async () => {
  const f = fakeOk();
  const cap = new MemoryCapture({ url: "http://127.0.0.1:49999/", token: "fdm_t", fetchImpl: f.impl, log: { warn() {} } });
  cap.observe({ namespace: "d/p1/a1", sessionId: "s1", summary: "message turn ok (10ms)" });
  await cap.drain();
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].url, "http://127.0.0.1:49999/capture");
  assert.equal(f.seen[0].init.headers.authorization, "Bearer fdm_t");
  const body = JSON.parse(f.seen[0].init.body);
  assert.equal(body.namespace, "d/p1/a1");
  assert.equal(body.events[0].event, "stop");
  assert.equal(body.events[0].session_id, "s1");
});

test("MemoryCapture fails open: endpoint 500 drops a counted gap, never throws", async () => {
  let calls = 0;
  const cap = new MemoryCapture({
    url: "http://127.0.0.1:1",
    token: "fdm_t",
    fetchImpl: async () => { calls++; throw new Error("ECONNREFUSED"); },
    log: { warn() {} },
    now: () => 0,
  });
  cap.observe({ namespace: "d/p/a", sessionId: "s1", summary: "x" });
  await cap.drain();
  await cap.drain();
  assert.ok(calls >= 1);
  assert.equal(cap.droppedBatches >= 1, true);
});

test("MemoryCapture disabled without url/token: observe is a no-op", async () => {
  const cap = new MemoryCapture({ url: "", token: "", fetchImpl: async () => { throw new Error("must not call"); } });
  cap.observe({ namespace: "d/p/a", sessionId: "s1" });
  await cap.drain();
  assert.equal(cap.enabled, false);
});

test("discipline text (SDK single source): bilingual, handoff-marked, one string for every surface", () => {
  // fix-memory-capture-p0 D6 decision: the text is bilingual by decision; both
  // languages ride in the ONE string every surface (cell presets via
  // dsh-profile, runner workspaces via compose-acp) injects from the SDK.
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_begin"));
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_accept"));
  assert.ok(MEMORY_DISCIPLINE.includes("工作记忆（fd-memory）"));
  assert.ok(MEMORY_DISCIPLINE.includes("Working memory (fd-memory)"));
});

test("ACP workspace CLAUDE.md carries the memory discipline when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-acp-"));
  try {
    const entry = { name: "agent1", metadata: { packId: "p1", agentId: "agent1", persona: "You are a test agent.", harness: "acp-claude-code" } };
    const spec = materializeAcpWorkspace({ homeRoot: dir, agentKey: "packs-p1-agent1", entry, skillContents: {}, harnessName: "acp-claude-code", memoryDiscipline: MEMORY_DISCIPLINE });
    const claude = readFileSync(join(spec.workspace, "CLAUDE.md"), "utf8");
    assert.ok(claude.startsWith("You are a test agent."));
    assert.ok(claude.includes("Working memory (fd-memory)"));
    assert.ok(claude.includes("memory_handoff_begin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP workspace without memoryDiscipline stays byte-identical to pre-change output", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-acp2-"));
  try {
    const entry = { name: "agent1", metadata: { packId: "p1", agentId: "agent1", persona: "You are a test agent.", harness: "acp-claude-code" } };
    const spec = materializeAcpWorkspace({ homeRoot: dir, agentKey: "k1", entry, skillContents: {}, harnessName: "acp-claude-code" });
    const claude = readFileSync(join(spec.workspace, "CLAUDE.md"), "utf8");
    assert.ok(!claude.includes("mcp__fd-memory__"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acpMcpServers rows keep the SDK header-array shape (memory row appended by manager matches it)", () => {
  const rows = acpMcpServers(["srv1"], { mcpUrlFor: () => "https://mcp.example/mcp" }, "tok");
  assert.deepEqual(rows[0].headers, [{ name: "Authorization", value: "Bearer tok" }]);
  assert.equal(rows[0].type, "http");
});

test("P0 grouped flush: two deployments alternating never cross-deliver (mutation-pinned)", async () => {
  const f = fakeOk();
  const cap = new MemoryCapture({ url: "http://127.0.0.1:49999/", token: "fdm_t", fetchImpl: f.impl, log: { warn() {} } });
  for (let i = 0; i < 3; i++) {
    cap.observe({ namespace: "d/p1/A", sessionId: `sessA${i}`, summary: `A${i}` });
    cap.observe({ namespace: "d/p2/B", sessionId: `sessB${i}`, summary: `B${i}` });
  }
  await cap.drain();
  assert.equal(f.seen.length, 2); // one POST per namespace group
  const byNs = new Map(f.seen.map((s) => JSON.parse(s.init.body)).map((b) => [b.namespace, b]));
  assert.deepEqual([...byNs.keys()].sort(), ["d/p1/A", "d/p2/B"]);
  for (const [ns, b] of byNs) {
    assert.equal(b.events.length, 3);
    const want = ns === "d/p1/A" ? "sessA" : "sessB";
    for (const e of b.events) assert.ok(e.session_id.startsWith(want), `${ns} got ${e.session_id}`);
  }
});

test("P0 grouped flush: one namespace's failure requeues only that group", async () => {
  const posts = [];
  const cap = new MemoryCapture({
    url: "http://127.0.0.1:49999/",
    token: "fdm_t",
    log: { warn() {} },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      posts.push(body.namespace);
      return body.namespace === "d/p1/A" ? { ok: false, status: 500 } : { ok: true, status: 200 };
    },
  });
  cap.observe({ namespace: "d/p1/A", sessionId: "sA", summary: "x" });
  cap.observe({ namespace: "d/p2/B", sessionId: "sB", summary: "y" });
  await cap.drain();
  assert.equal(cap.droppedBatches, 1);
  assert.deepEqual([...posts].sort(), ["d/p1/A", "d/p2/B"]); // B went out despite A's 500
  assert.deepEqual(cap.queue.map((i) => i.namespace), ["d/p1/A"]); // only A requeued
});

test("P0 observation shapes: intent / tool / turn serialize into hooks-shaped events in order", async () => {
  const f = fakeOk();
  const cap = new MemoryCapture({ url: "http://127.0.0.1:49999/", token: "fdm_t", fetchImpl: f.impl, log: { warn() {} } });
  cap.observe({ namespace: "d/p/a", sessionId: "s", event: "user-prompt-submit", summary: "查余额".repeat(200) }); // 600 chars — runner caps intent at 500 before this seam
  cap.observe({ namespace: "d/p/a", sessionId: "s", event: "pre-tool-use", toolName: "bash", summary: compactJsonText({ command: "ls -la" }, 600) });
  cap.observe({ namespace: "d/p/a", sessionId: "s", event: "post-tool-use", toolName: "bash", summary: "error: " + "E".repeat(900) });
  cap.observe({ namespace: "d/p/a", sessionId: "s", summary: "message turn ok (10ms)" }); // stop (default)
  await cap.drain();
  const body = JSON.parse(f.seen[0].init.body);
  assert.deepEqual(body.events.map((e) => e.event), ["user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"]);
  assert.equal(body.events[0].summary.length, 600);
  assert.ok(body.events[3].summary.length <= 2000);
  assert.equal(body.events[1].tool_name, "bash");
  assert.ok(body.events[1].summary.includes('"command":"ls -la"'));
  assert.ok(body.events[2].summary.startsWith("error: "));
  assert.ok(body.events[2].summary.length <= 2000); // fd-memory hard cap mirrored here
  for (const e of body.events) assert.equal(e.agent, "platform-manager");
});

test("P0 compactJsonText: canonical single-line JSON, string inputs re-parsed, capped with ellipsis", () => {
  assert.equal(compactJsonText('{"a": 1}', 100), '{"a":1}');
  assert.equal(compactJsonText({ a: 1 }, 100), '{"a":1}');
  assert.equal(compactJsonText("not json", 100), "not json");
  assert.equal(compactJsonText({ a: "x".repeat(50) }, 10), '{"a":"xxx…'); // 9 chars + ellipsis
  assert.equal(compactJsonText(null, 10), "null");
});

// Fixtures mirror the two documented production shapes — FLAT is what dsh
// emits live (704/704 events on a prod cell, 2026-10-22); WRAPPER is what
// older fixtures assumed. Same sampling as scripts/test-dsh-tool-result-shape.mjs.
const dshFlatResult = (text, { callId = "tc1", isError = false } = {}) => ({
  type: "tool/result",
  data: { message: { source: { kind: "tool", callId }, content: [{ type: "text", text }], isError, id: "msg-1" } },
});
const dshWrapperResult = (text, { callId = "tc1", isError = false } = {}) => ({
  type: "tool/result",
  data: { message: { source: { callId }, content: [{ toolCallId: callId, isError, content: [{ type: "text", text }] }] } },
});

test("P0 dshToolEvent: tool/call + tool/result (flat & wrapper) map correctly; name recalled from the call", () => {
  const names = new Map();
  const call = dshToolEvent({ type: "tool/call", data: { callId: "tc1", name: "bash", arguments: '{"command":"ls"}' } }, names);
  assert.deepEqual(
    [call.type, call.callId, call.toolName, call.args],
    ["tool_call", "tc1", "bash", '{"command":"ls"}'],
  );
  assert.equal(names.get("tc1"), "bash");
  for (const mk of [dshFlatResult, dshWrapperResult]) {
    const res = dshToolEvent(mk("done"), names);
    assert.equal(res.type, "tool_result");
    assert.equal(res.toolName, "bash"); // dsh's result event carries no name
    assert.equal(res.resultText, "done");
    assert.equal(res.isError, false);
  }
  const err = dshToolEvent(dshFlatResult("Error: 401 Unauthorized", { isError: true }), names);
  assert.equal(err.isError, true);
  assert.equal(err.resultText, "Error: 401 Unauthorized");
  assert.equal(dshToolEvent({ type: "assistant/message", data: {} }, names), null);
});

test("P0 acpToolEvent: bridge-wrapped and spec-native content both parse; failed marks error; non-terminal ignored", () => {
  const names = new Map();
  const call = acpToolEvent(
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "in_progress", rawInput: { command: "ls" } },
    names,
  );
  assert.deepEqual([call.type, call.callId, call.toolName], ["tool_call", "t1", "bash"]);
  assert.deepEqual(call.args, { command: "ls" });
  assert.equal(names.get("t1"), "bash");
  // dsh-acp bridge shape (verified against node_modules/@deepseek-ai/dsh-acp):
  // content blocks wrapped in {type:"content", content:<block>}
  const bridgeDone = acpToolEvent(
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] },
    names,
  );
  assert.equal(bridgeDone.resultText, "ok");
  assert.equal(bridgeDone.toolName, "bash"); // recalled — result updates carry no name
  assert.equal(bridgeDone.isError, false);
  // spec-native shape: blocks direct (claude-code-acp)
  const nativeFail = acpToolEvent(
    { sessionUpdate: "tool_call_update", toolCallId: "t9", status: "failed", content: [{ type: "text", text: "Error: x" }] },
    names,
  );
  assert.equal(nativeFail.resultText, "Error: x");
  assert.equal(nativeFail.isError, true);
  assert.equal(nativeFail.toolName, null);
  // non-terminal and unrelated kinds are not observations
  assert.equal(acpToolEvent({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }, names), null);
  assert.equal(acpToolEvent({ sessionUpdate: "plan" }, names), null);
  // rawOutput fallback when no content blocks
  const raw = acpToolEvent({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { code: 0 } }, names);
  assert.equal(raw.resultText, '{"code":0}');
});

test("P0 pod composition: no memory mount → no discipline in member personas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-pod-"));
  try {
    const member = { agentKey: "packs-pk-a1", entry: { name: "a1", metadata: { packId: "pk", persona: "你是成员一。" } } };
    const spec = await materializePackHome({ homeRoot: dir, packId: "pk", memberSpecs: [member], mcpServers: [], memoryDiscipline: null });
    const patch = readFileSync(spec.patchPaths.find((x) => x.endsWith("presets.patch.yml")), "utf8");
    assert.ok(!patch.includes("mcp__fd-memory__"));
    assert.ok(!patch.includes("工作记忆"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0 pod composition: discipline provided (per-member mounts, later change) rides the persona", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-pod2-"));
  try {
    const member = { agentKey: "packs-pk-a1", entry: { name: "a1", metadata: { packId: "pk", persona: "你是成员一。" } } };
    const spec = await materializePackHome({ homeRoot: dir, packId: "pk", memberSpecs: [member], mcpServers: [], memoryDiscipline: MEMORY_DISCIPLINE });
    const patch = readFileSync(spec.patchPaths.find((x) => x.endsWith("presets.patch.yml")), "utf8");
    assert.ok(patch.includes("mcp__fd-memory__"));
    assert.ok(patch.includes("memory_handoff_begin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mounts wiring (shapes from the SDK; golden rows as compose INPUTS) ──────

// Golden dsh loader row in the historical shape — used as INPUT material for
// the compose wiring tests below. The SDK-produced row shape itself is pinned
// (skipped until the mounts module ships) in the dshMemoryMount test.
function goldenDshRow(url, token) {
  return {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

test("mounts: memoryNamespaceFor — metadata.agentId is the coordinate, display name only a legacy fallback", { skip: mountsSkip }, () => {
  const withBoth = { name: "爬虫自愈修复 Agent", metadata: { packId: "KkCi", agentId: "spider-heal" } };
  assert.equal(YongYi.memoryNamespaceFor(withBoth), "d/KkCi/spider-heal");
  const legacyNameOnly = { name: "萬星 Planner", metadata: { packId: "i262" } };
  assert.equal(YongYi.memoryNamespaceFor(legacyNameOnly), "d/i262/萬星 Planner");
  assert.equal(YongYi.memoryNamespaceFor({ metadata: { packId: "p" } }), null);
  assert.equal(YongYi.memoryNamespaceFor({ name: "x", metadata: {} }), null);
  assert.equal(YongYi.memoryNamespaceFor(null), null);
});

test("mounts: podMemoryNamespace — two-segment pack-shared namespace for the pod token", { skip: mountsSkip }, () => {
  assert.equal(YongYi.podMemoryNamespace("pk1"), "d/pk1");
  assert.equal(YongYi.podMemoryNamespace(null), null);
});

test("mounts: dshMemoryMount — loader row shape, no token → zero headers key", { skip: mountsSkip }, () => {
  const dsh = YongYi.dshMemoryMount("http://127.0.0.1:49375/mcp", "fdm_dep");
  assert.deepEqual(dsh, {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: "http://127.0.0.1:49375/mcp",
      headers: { Authorization: "Bearer fdm_dep" },
    },
  });
  const anon = YongYi.dshMemoryMount("http://127.0.0.1:49375/mcp", null);
  assert.equal("headers" in anon.config, false, "no token → zero headers key");
});

test("mounts: acpMemoryMount — ACP SDK wire row, headers as an ARRAY; no token → empty array", { skip: mountsSkip }, () => {
  const acp = YongYi.acpMemoryMount("http://127.0.0.1:49375/mcp", "fdm_dep");
  assert.deepEqual(acp, {
    type: "http",
    name: "fd-memory",
    url: "http://127.0.0.1:49375/mcp",
    headers: [{ name: "Authorization", value: "Bearer fdm_dep" }],
  });
  assert.deepEqual(YongYi.acpMemoryMount("http://x/mcp", null).headers, []);
});

test("scopes: pod composition carries the shared mount row and the discipline together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-pod3-"));
  try {
    const member = { agentKey: "packs-pk-a1", entry: { name: "显示名甲", metadata: { packId: "pk", agentId: "a1", persona: "你是成员一。" } } };
    const podToken = "fdm_podtest";
    const spec = await materializePackHome({
      homeRoot: dir,
      packId: "pk",
      memberSpecs: [member],
      mcpServers: [goldenDshRow("http://memory.test/mcp", podToken)],
      memoryDiscipline: MEMORY_DISCIPLINE,
    });
    const patch = readFileSync(spec.patchPaths.find((x) => x.endsWith("mcp.patch.yml")), "utf8");
    assert.ok(patch.includes("fd-memory"), "shared MCP patch carries the memory mount row");
    const presets = readFileSync(spec.patchPaths.find((x) => x.endsWith("presets.patch.yml")), "utf8");
    assert.ok(presets.includes("memory_handoff_begin"), "member persona carries the discipline text");
    assert.ok(presets.includes("工作记忆"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scopes: pod composition without a mount keeps the discipline out (degrade open)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-pod4-"));
  try {
    const member = { agentKey: "packs-pk-a1", entry: { name: "a1", metadata: { packId: "pk", persona: "你是成员一。" } } };
    const spec = await materializePackHome({ homeRoot: dir, packId: "pk", memberSpecs: [member], mcpServers: [], memoryDiscipline: null });
    const presets = readFileSync(spec.patchPaths.find((x) => x.endsWith("presets.patch.yml")), "utf8");
    const patchPath = spec.patchPaths.find((x) => x.endsWith("mcp.patch.yml"));
    const patch = patchPath ? readFileSync(patchPath, "utf8") : "";
    assert.ok(!presets.includes("工作记忆"));
    assert.ok(!patch.includes("fd-memory"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
