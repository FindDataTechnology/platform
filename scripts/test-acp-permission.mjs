// ACP 权限门：agent → client 的 `session/request_permission` 必须被应答。
//
// 2026-11-12 生产现象：让一个 harness=acp-claude-code 的 agent 调任意工具，
// 回合 200+s 不返回、平台侧零建行。根因不在 MCP 挂载（工具面里 `mcp__*` 都在），
// 而是 claude-code-acp 以 permissionMode "default" 运行，其 canUseTool() 会向
// **客户端**发 `session/request_permission` 并阻塞等裁定；适配器的 #onLine 只处理
// 「响应」和 `session/update`，凡带 method+id 的入站请求一律被丢掉 ⇒ 永无裁定 ⇒
// 工具永不执行。这不止影响提卡，Bash/Read/Edit 等全部工具同样挂死。
//
// 这个套件用一个内联假 agent 复现那条线：它发请求、等裁定、把裁定写进输出。
//
//   node --test scripts/test-acp-permission.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpHarnessAdapter } from "../agent-runner/harness/acp.js";

const SILENT_LOG = { log() {}, warn() {}, error() {} };

// 假 agent：session/prompt 时先发一条 request_permission，等客户端裁定，
// 再把裁定拼进 assistant 文本。没有裁定时它会一直等（正是生产上的挂死）。
const FAKE = `
const sessions = new Set();
const parked = new Map();
function out(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
let buf = "";
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === undefined) { const r = parked.get(m.id); if (r) { parked.delete(m.id); r(m.result || m.error); } continue; }
    const { id, method, params } = m;
    switch (method) {
      case "initialize": out({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }); break;
      case "session/new": { const s = "s-" + (sessions.size + 1); sessions.add(s); out({ jsonrpc: "2.0", id, result: { sessionId: s } }); break; }
      case "session/set_config_option": out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }); break;
      case "session/prompt": {
        const verdict = await ask(id, params);
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: verdict } } } });
        out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        break;
      }
      default: out({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
    }
  }
});
function ask(_promptId, params) {
  return new Promise((resolve) => {
    const rid = 900 + parked.size;
    parked.set(rid, (res) => {
      const o = res && res.outcome ? res.outcome : {};
      resolve(o.outcome === "selected" ? "verdict:" + o.optionId : "verdict:" + (o.outcome || "none"));
    });
    out({ jsonrpc: "2.0", id: rid, method: "session/request_permission", params: {
      sessionId: params.sessionId,
      options: [
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      toolCall: { toolCallId: "tc-1", title: "mcp__input-request__request_input", rawInput: {} },
    } });
  });
}
`;

const dir = mkdtempSync(path.join(os.tmpdir(), "acpperm-"));
const FAKE_PATH = path.join(dir, "fake-permission-agent.mjs");
writeFileSync(FAKE_PATH, FAKE);

function adapter() {
  return new AcpHarnessAdapter({
    key: "acp-perm",
    spawnSpec: { command: process.execPath, args: [FAKE_PATH], cwd: dir, env: { ...process.env }, provider: "p", model: "m" },
    log: SILENT_LOG,
  });
}

test("[acp] an inbound session/request_permission is answered (the tool call no longer hangs)", async () => {
  const a = adapter();
  await a.start();
  try {
    const t0 = Date.now();
    const res = await a.turn("ctx-1", "please call the tool", {});
    const ms = Date.now() - t0;
    assert.match(String(res?.text ?? ""), /verdict:allow/, `agent received an allow verdict (got: ${res?.text})`);
    assert.ok(ms < 20_000, `answered promptly (${ms}ms) instead of waiting`);
  } finally {
    await a.stop();
  }
});

test("[acp] AGENT_RUNNER_ACP_PERMISSION=deny answers with a cancelled outcome", async () => {
  process.env.AGENT_RUNNER_ACP_PERMISSION = "deny";
  const a = adapter();
  await a.start();
  try {
    const res = await a.turn("ctx-2", "please call the tool", {});
    assert.match(String(res?.text ?? ""), /verdict:cancelled|cancelled/, `deny lane answers cancelled (got: ${res?.text})`);
  } finally {
    await a.stop();
    delete process.env.AGENT_RUNNER_ACP_PERMISSION;
  }
});
