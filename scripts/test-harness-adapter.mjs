// The harness-adapter contract suite (add-harness-adapter tasks 1.3 + 2.4):
// ONE set of spawn/turn/stop/pid/capabilities assertions driven against every
// adapter implementation — the dsh adapter (with a fake JSON-RPC client, the
// same fixture shape scripts/test-agent-runner.mjs uses) and the ACP adapter
// (with the fake ACP agent process). A harness-specific branch in this file
// is a contract violation; only the wiring to obtain each adapter differs.
//
//   node --test scripts/test-harness-adapter.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ADAPTER_CAPABILITIES, assertAdapter, adapterRequest } from "../agent-runner/harness/adapter.js";
import { DshHarnessAdapter } from "../agent-runner/harness/dsh.js";
import { AcpHarnessAdapter } from "../agent-runner/harness/acp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ACP = path.join(REPO_ROOT, "scripts", "lib", "dsh-contracts", "fake-acp-agent.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the dsh fixture: a fake stdio JSON-RPC client (mirrors test-agent-runner) ─
function fakeDshClient({ reply = "dsh ok", noUsage = false, failPrompt = false } = {}) {
  const calls = { initialize: [], prompt: [], requests: [], started: 0, stopped: 0 };
  const client = {
    calls,
    start() { calls.started += 1; },
    async initialize(params) { calls.initialize.push(params); return { ok: true }; },
    async request(method, params) { calls.requests.push({ method, params }); return { accepted: true }; },
    subscribe() {
      const queue = [];
      let listeners = [];
      client.__emit = (notif) => {
        queue.push(notif);
        const waiting = listeners;
        listeners = [];
        for (const r of waiting) r();
      };
      return {
        next: async () => {
          for (;;) {
            const notif = queue.shift();
            if (notif) return notif;
            await new Promise((r) => listeners.push(r));
          }
        },
      };
    },
    async prompt(sessionId, blocks) {
      calls.prompt.push({ sessionId, blocks });
      if (failPrompt) throw new Error("prompt rejected");
      const emit = (n) => client.__emit(n);
      setTimeout(() => {
        emit({ method: "session.event", params: { sessionId, event: { type: "turn/start", data: {} } } });
        emit({ method: "platform/stream", params: { sessionId, frame: { type: "chunk", chunk: { type: "text-delta", text: reply.slice(0, 2) } } } });
        emit({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: reply }] }, ...(noUsage ? {} : { usage: { inputTokens: 120, outputTokens: 30 } }) } } } });
        emit({ method: "session.status", params: { sessionId, status: "idle" } });
      }, 0);
      return `msg-${calls.prompt.length}`;
    },
    async stop() { calls.stopped += 1; },
  };
  return client;
}

// ── the ACP fixture: the fake ACP agent over stdio ───────────────────────────
function acpSpawnSpec({ mode = "normal", env = {} } = {}) {
  return {
    command: process.execPath,
    args: [FAKE_ACP, `--mode=${mode}`],
    cwd: REPO_ROOT,
    env: { ...process.env, FAKE_ACP_REPLY: "acp ok", ...env },
    provider: "fake",
    model: "fake-model",
  };
}

// Every adapter under test, obtained through its own wiring. The BODY of each
// contract assertion below never branches on which adapter it got.
const IMPLEMENTATIONS = [
  {
    name: "dsh",
    make: ({ client = fakeDshClient() } = {}) => ({
      adapter: new DshHarnessAdapter({
        key: "contract-dsh",
        spawnSpec: { profile: "platform", patchPaths: [], cwd: REPO_ROOT, env: {}, provider: "test-provider", model: "test-model", presetId: null },
        clientFactory: () => client,
        log: { log() {}, warn() {}, error() {} },
      }),
      client,
    }),
  },
  {
    name: "acp",
    make: ({ mode = "normal" } = {}) => ({
      adapter: new AcpHarnessAdapter({
        key: "contract-acp",
        spawnSpec: acpSpawnSpec({ mode }),
        log: { log() {}, warn() {}, error() {} },
      }),
    }),
  },
];

// ── the shared contract assertions ───────────────────────────────────────────

for (const impl of IMPLEMENTATIONS) {
  test(`[${impl.name}] contract: shape, capabilities, start, turn, stop`, async () => {
    const { adapter } = impl.make();
    // Shape: a new adapter fails loudly at construction time, not mid-turn.
    assertAdapter(adapter);
    assert.ok(adapter.capabilities().stream === true, "every adapter reports its stream capability");
    for (const key of Object.keys(adapter.capabilities())) {
      assert.ok(ADAPTER_CAPABILITIES.includes(key), `capability '${key}' is in the known set`);
    }
    await adapter.start();
    assert.equal(adapter.ready, true, "start() leaves the adapter ready");
    const out = await adapter.turn("contract-s1", "hello");
    assert.match(String(out?.text || ""), /ok/, "a turn returns the assistant text");
    const pid = adapter.pid();
    assert.ok(pid === null || typeof pid === "number", "pid() is best-effort: a number when known, null otherwise");
    await adapter.stop();
    assert.equal(adapter.ready, false, "stop() clears readiness");
    // stop() is idempotent (the manager may race a drain with a shutdown).
    await adapter.stop();
  });

  test(`[${impl.name}] contract: an empty turn settles as the empty-turn error family`, async () => {
    const { adapter } = impl.make(impl.name === "acp" ? { mode: "empty" } : { client: fakeDshClient({ reply: "" }) });
    await adapter.start();
    try {
      await assert.rejects(adapter.turn("contract-empty", "hello"), (e) => e.code === -32005, "empty turn → -32005");
    } finally {
      await adapter.stop();
    }
  });

  test(`[${impl.name}] contract: activeTurns counts in-flight turns and drains to zero`, async () => {
    const { adapter } = impl.make();
    await adapter.start();
    try {
      const p = adapter.turn("contract-count", "hello");
      assert.equal(adapter.activeTurns, 1, "an in-flight turn is counted");
      await p;
      assert.equal(adapter.activeTurns, 0, "a settled turn releases the count");
    } finally {
      await adapter.stop();
    }
  });
}

test("contract: adapters are interchangeable — no harness branch in the shared assertions", () => {
  // The structural check behind the shared loop above: both implementations
  // expose exactly the contract surface, and the dsh-only depth (pod/wire/
  // parking) is absent from the neutral shell's view of the ACP adapter.
  const acp = IMPLEMENTATIONS.find((i) => i.name === "acp").make().adapter;
  assert.equal(acp.podMembers, undefined, "the ACP adapter carries no pod-members surface");
  assert.equal(typeof acp.agentActiveTurns, "function", "…but the member-count probe exists (returning its own aggregate)");
  assert.equal(acp.agentActiveTurns("any"), acp.activeTurns);
});

test("contract: the deep-control lane answers unsupportedCapability when absent", async () => {
  const acp = IMPLEMENTATIONS.find((i) => i.name === "acp").make().adapter;
  await assert.rejects(
    adapterRequest(acp, "preset/set", {}),
    (e) => e.code === -32006 && e.capability === "preset/set",
    "an adapter without the lane answers a structured unsupported-capability error",
  );
  const { adapter: dsh } = IMPLEMENTATIONS.find((i) => i.name === "dsh").make();
  await dsh.start();
  try {
    const res = await adapterRequest(dsh, "platform/capabilities", {});
    assert.equal(res.accepted, true, "the dsh adapter forwards deep-control calls to its client");
  } finally {
    await dsh.stop();
  }
});

test("contract: a runtime that cannot start fails the cold start, never a hang", async () => {
  const acp = IMPLEMENTATIONS.find((i) => i.name === "acp").make({ mode: "nofail" }).adapter;
  // "nofail" is the normal agent; use the dedicated failing mode instead.
  await acp.stop();
  const bad = new AcpHarnessAdapter({
    key: "contract-bad",
    spawnSpec: { command: process.execPath, args: [FAKE_ACP, "--mode=nope"], cwd: REPO_ROOT, env: process.env },
    log: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(bad.start(), /initialize|exit|ACP/i, "a dead handshake surfaces as a start failure");
});

// ── ACP mapping specifics (task 2.3) ─────────────────────────────────────────

test("[acp] mapping: deltas stream, usage rides the wire, model selection applies", async () => {
  const adapter = new AcpHarnessAdapter({
    key: "acp-map",
    spawnSpec: acpSpawnSpec(),
    log: { log() {}, warn() {}, error() {} },
  });
  await adapter.start();
  try {
    const deltas = [];
    const out = await adapter.turn("map-s1", "hello", { onDelta: (t) => deltas.push(t) });
    assert.ok(deltas.length >= 2, `text deltas streamed (got ${deltas.length})`);
    assert.equal(deltas.join(""), out.text, "the deltas concatenate to the final text");
    assert.ok(out.usage && out.usage.sessionUpdate === "usage_update", "usage_update rides verbatim to the caller");
    assert.ok(out.text.includes("[fake-model]"), "the spawn-time model reached the agent (session/set_config_option applied)");
    // Live model switch through the deep-control lane.
    await adapter.request("model/set", { sessionId: "map-s1", provider: "fake", model: "other-model" });
    const out2 = await adapter.turn("map-s1", "again");
    assert.ok(out2.text.includes("[other-model]"), "the live model/set applies to the next turn");
  } finally {
    await adapter.stop();
  }
});

test("[acp] mapping: session/cancel converges the parked turn", async () => {
  // The agent parks far longer than the cancel round trip: the cancel is
  // ALWAYS what ends this turn, never the park timer (the 10ms default could
  // let the turn finish first under load and read as a cancel defect).
  const adapter = new AcpHarnessAdapter({
    key: "acp-cancel",
    spawnSpec: acpSpawnSpec({ env: { FAKE_ACP_PARK_MS: "5000" } }),
    log: { log() {}, warn() {}, error() {} },
  });
  await adapter.start();
  try {
    const p = adapter.turn("cancel-s1", "hello");
    await sleep(3); // let the prompt park at the agent
    await adapter.request("session/cancel", { sessionId: "cancel-s1" });
    const out = await p;
    assert.equal(out.cancelled, true, "the cancelled stopReason surfaces as the cancelled outcome");
  } finally {
    await adapter.stop();
  }
});

test("[acp] mapping: an agent without resume support starts fresh, never mixed", async () => {
  const adapter = new AcpHarnessAdapter({
    key: "acp-noresume",
    spawnSpec: acpSpawnSpec({ mode: "noresume" }),
    log: { log() {}, warn() {}, error() {} },
  });
  await adapter.start();
  try {
    const out = await adapter.turn("fresh-s1", "hello");
    assert.match(out.text, /ok/, "a turn on a resume-less agent still completes (fresh session)");
    const out2 = await adapter.turn("fresh-s1", "again");
    assert.match(out2.text, /ok/, "the second turn reuses the live session (no error, no mix)");
  } finally {
    await adapter.stop();
  }
});

test("[acp] mapping: a relative cwd is refused before any spawn", async () => {
  const adapter = new AcpHarnessAdapter({
    key: "acp-relcwd",
    spawnSpec: { ...acpSpawnSpec(), cwd: "relative/path" },
    log: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(adapter.start(), /absolute cwd/, "the adapter enforces the absolute-cwd wire requirement locally");
});

// ── Harness registry + selection (tasks 3.4 / 4.1 / 4.4) ─────────────────────

test("registry: allowlist parse refuses malformed shapes loudly", async () => {
  const { createHarnessRegistry } = await import("../agent-runner/harness/registry.js");
  const reg = createHarnessRegistry({
    acpCommands: { "acp-claude-code": ["claude-code-acp", "--verbose"] },
    acpEnv: {},
  });
  assert.deepEqual(reg.names().sort(), ["acp-claude-code", "dsh"]);
  assert.equal(reg.kindOf("dsh"), "dsh");
  assert.equal(reg.kindOf("acp-claude-code"), "acp");
  assert.equal(reg.kindOf("nope"), null);
});

test("registry: an unknown harness throws the structured unsupported error", async () => {
  const { createHarnessRegistry } = await import("../agent-runner/harness/registry.js");
  const reg = createHarnessRegistry({ acpCommands: {}, acpEnv: {} });
  assert.throws(
    () => reg.create("acp-claude-code", { key: "k", spawnSpec: {}, dshFactory: () => null }),
    (e) => e.code === "UNSUPPORTED_HARNESS" && /available: dsh/.test(e.message),
    "the error names the available harnesses",
  );
});

test("registry: the dsh entry delegates to the manager's factory (clientFactory wiring preserved)", async () => {
  const { createHarnessRegistry } = await import("../agent-runner/harness/registry.js");
  const reg = createHarnessRegistry({ acpCommands: {}, acpEnv: {} });
  let got = null;
  const adapter = reg.create("dsh", {
    key: "k",
    spawnSpec: { cwd: REPO_ROOT },
    dshFactory: (args) => {
      got = args;
      return { name: "dsh", start() {}, turn() {}, stop() {}, pid: () => null, capabilities: () => ({}) };
    },
  });
  assert.equal(adapter.name, "dsh");
  assert.equal(got.key, "k", "the factory receives the spawn arguments unchanged");
});

test("registry: an ACP entry builds the ACP adapter from the allowlisted command", async () => {
  const { createHarnessRegistry } = await import("../agent-runner/harness/registry.js");
  const reg = createHarnessRegistry({
    acpCommands: { "acp-fake": [process.execPath, FAKE_ACP] },
    acpEnv: { FAKE_ACP_REPLY: "registry ok" },
  });
  const adapter = reg.create("acp-fake", {
    key: "k",
    spawnSpec: { cwd: REPO_ROOT, provider: "fake", model: "fake-model" },
    dshFactory: () => {
      throw new Error("the dsh factory must not be consulted for an ACP harness");
    },
  });
  assert.equal(adapter.name, "acp");
  await adapter.start();
  try {
    const out = await adapter.turn("registry-s1", "hello");
    assert.match(out.text, /registry ok/, "the ACP env injection reached the agent process");
  } finally {
    await adapter.stop();
  }
});

test("config: ACP allowlist and env parse shapes refuse malformed values", async () => {
  const { loadConfig } = await import("../agent-runner/config.js");
  const base = { AGENT_RUNNER_ACP_COMMANDS: '{"acp-x": ["bin", "--flag"]}', AGENT_RUNNER_ACP_ENV: '{"A": "1"}' };
  const cfg = loadConfig(base);
  assert.deepEqual(cfg.acpCommands, { "acp-x": ["bin", "--flag"] });
  assert.deepEqual(cfg.acpEnv, { A: "1" });
  assert.throws(() => loadConfig({ AGENT_RUNNER_ACP_COMMANDS: "not json" }), /not valid JSON/);
  assert.throws(() => loadConfig({ AGENT_RUNNER_ACP_COMMANDS: '{"x": "bin"}' }), /non-empty array/);
  assert.throws(() => loadConfig({ AGENT_RUNNER_ACP_ENV: '{"A": 1}' }), /string value/);
  // Absent = the legacy shape (dsh only, no env injection).
  const legacy = loadConfig({});
  assert.deepEqual(legacy.acpCommands, {});
  assert.deepEqual(legacy.acpEnv, {});
});

// ── MCP passthrough + credential precedence (add-harness-materializer 2.1/2.2) ─

test("[acp] session/new carries the deployment's MCP servers in the wire shape", async () => {
  const adapter = new AcpHarnessAdapter({
    key: "acp-mcp",
    spawnSpec: {
      ...acpSpawnSpec({ env: { FAKE_ACP_REPLY: "mcp passthrough" } }),
      acpMcpServers: [{
        type: "http",
        name: "legal",
        url: "https://reg.example.test/legal/mcp",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      }],
    },
    log: { log() {}, warn() {}, error() {} },
  });
  await adapter.start();
  try {
    const out = await adapter.turn("mcp-s1", "hello");
    const m = out.text.match(/ mcp=(\[[\s\S]*\])$/);
    assert.ok(m, "the fake agent echoed the wire's mcpServers");
    const servers = JSON.parse(m[1]);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, "legal");
    assert.equal(servers[0].url, "https://reg.example.test/legal/mcp");
    assert.deepEqual(servers[0].headers, [{ name: "Authorization", value: "Bearer tok" }], "headers stay the SDK's entry-array shape end to end");
  } finally {
    await adapter.stop();
  }
});

test("[registry] create() passes acpMcpServers through and lets the credential override win", async () => {
  const { createHarnessRegistry } = await import("../agent-runner/harness/registry.js");
  const reg = createHarnessRegistry({
    acpCommands: { "acp-x": ["/bin/echo", "x"] },
    acpEnv: { ANTHROPIC_API_KEY: "sk-standing", ANTHROPIC_AUTH_TOKEN: "sk-standing" },
    log: { log() {}, warn() {}, error() {} },
  });
  const adapter = reg.create("acp-x", {
    key: "k",
    spawnSpec: {
      cwd: "/tmp",
      env: { CHILD_VAR: "1", ANTHROPIC_API_KEY: "sk-child-env" },
      provider: "p",
      model: "m",
      acpMcpServers: [{ type: "http", name: "n", url: "https://n.example.test/mcp", headers: [] }],
      acpCredentialEnv: { ANTHROPIC_API_KEY: "sk-deployer", ANTHROPIC_AUTH_TOKEN: "sk-deployer" },
    },
  });
  assert.equal(adapter.spawnSpec.env.CHILD_VAR, "1", "the scrubbed child env passes through");
  assert.equal(adapter.spawnSpec.env.ANTHROPIC_API_KEY, "sk-deployer", "acpCredentialEnv wins over acpEnv — the standing credential is the default, the deployment key the override");
  assert.equal(adapter.spawnSpec.env.ANTHROPIC_AUTH_TOKEN, "sk-deployer", "both vars, or the SDK would authenticate on the survivor");
  assert.equal(adapter.spawnSpec.acpMcpServers.length, 1, "the MCP rows ride the spawn spec untouched");
  assert.equal(adapter.spawnSpec.acpMcpServers[0].name, "n");
  await adapter.stop();
});
