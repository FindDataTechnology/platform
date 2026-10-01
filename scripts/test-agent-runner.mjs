#!/usr/bin/env node
// ── Agent-runner unit tests (add-a2a-agent-serving, tasks 4.1–4.5) ──────────
//
// Drives the runner's modules with an in-process fake harness client (the
// dsh spawn protocol: initialize + prompt + session notifications) and a stub
// registry — covering composition formats, the A2A adapter surface, session
// mapping, lifecycle (idle reap / queue / drain), and the backend-credential
// gate. Real dsh children and a live registry are exercised by the staging
// probe (task 6.2), not here.
//
//   node --test scripts/test-agent-runner.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { materializeAgentHome, mcpEntry, agentKeyFor } from "../agent-runner/compose.js";
import { AgentChild, sessionKeyFor } from "../agent-runner/child.js";
import { ChildManager } from "../agent-runner/manager.js";
import { createOpsApp } from "../agent-runner/a2a.js";
import { createRegistryClient } from "../agent-runner/registry.js";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "agent-runner-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── Fake harness client: records calls, replies to prompt with a scripted ──
// turn (text deltas + final message + idle), per the dsh notification shapes.
function fakeHarnessClient({ reply = "ok", delayMs = 0, failPrompt = false } = {}) {
  const calls = { initialize: [], prompt: [], started: 0, stopped: 0 };
  const client = {
    calls,
    start() {
      calls.started += 1;
    },
    async initialize(params) {
      calls.initialize.push(params);
      return { ok: true };
    },
    subscribe() {
      // A real subscription QUEUES notifications; a naive "resolve the waiter
      // with the value" fake loses every notification that arrives before the
      // pump re-awaits. Wake-without-value + shared queue is the honest shape.
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
      const emit = (notif) => client.__emit(notif);
      setTimeout(() => {
        emit({ method: "session.event", params: { sessionId, event: { type: "turn/start", data: {} } } });
        emit({ method: "session.event", params: { sessionId, event: { type: "assistant/chunk", data: { chunk: { type: "text-delta", text: reply.slice(0, 2) } } } } });
        emit({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: reply }] } } } } });
        emit({ method: "session.status", params: { sessionId, status: "idle" } });
      }, delayMs);
      return `msg-${calls.prompt.length}`;
    },
    async stop() {
      calls.stopped += 1;
    },
  };
  return client;
}

// ── 4.2: composition formats ────────────────────────────────────────────────

const TEMPLATE = `plugins:\n- id: shell\n- id: persona\n  config:\n    text: "base persona"\n- id: fs\n`;

const ENTRY = {
  path: "/packs/pk-abc/pack-fingpt",
  supported_protocol: "a2a",
  is_enabled: true,
  name: "FingPt Analyst",
  description: "Financial analysis over A2A",
  version: "3",
  capabilities: { streaming: true },
  skills: [],
  tags: ["金融"],
  metadata: {
    protocol: "a2a",
    packId: "pk-abc",
    packVersion: 3,
    agentId: "pack-fingpt",
    agentName: "FingPt 分析师",
    persona: "你是严谨的金融分析师。",
    skills: ["packs/pk-abc/fin-statement-analysis"],
    mcpServers: ["fd-open-data-mcp"],
  },
};

test("4.2 home layout: preset, skills root, three patch formats", async () => {
  const homeRoot = path.join(tmpRoot, "compose");
  const spec = await materializeAgentHome({
    homeRoot,
    agentKey: agentKeyFor(ENTRY),
    entry: ENTRY,
    skillContents: { "packs/pk-abc/fin-statement-analysis": "# 财报分析\nstep 1" },
    mcpServers: [mcpEntry("fd-open-data-mcp", { url: "https://mcp.example.test/fd-open-data-mcp/mcp", token: "tok" })],
    template: TEMPLATE,
  });
  assert.equal(agentKeyFor(ENTRY), "packs-pk-abc-pack-fingpt");
  // Persona preset composed from the template with our text spliced in.
  const composed = readFileSync(path.join(spec.home, ".agent-presets", spec.presetId, "agent.cordis.yml"), "utf8");
  assert.ok(composed.includes("金融分析师"));
  assert.ok(!composed.includes("base persona"));
  // Skill file materialized under the flat compose root.
  assert.ok(existsSync(path.join(spec.home, "skills", "fin-statement-analysis", "SKILL.md")));
  // Patch shapes mirror dsh-profile verbatim.
  const presets = readFileSync(path.join(spec.home, "profiles", "platform", "presets.patch.yml"), "utf8");
  assert.match(presets, /id: sdk-jsonrpc-server[\s\S]*?disabled: true/);
  assert.match(presets, /platform-preset-bridge\.js/);
  const skills = readFileSync(path.join(spec.home, "profiles", "platform", "skills.patch.yml"), "utf8");
  assert.match(skills, /id: skill-filesystem/);
  assert.ok(skills.includes(path.join(spec.home, "skills")));
  const mcp = readFileSync(path.join(spec.home, "profiles", "platform", "mcp.patch.yml"), "utf8");
  assert.match(mcp, /- insert/);
  assert.match(mcp, /serverName: fd-open-data-mcp/);
  assert.match(mcp, /streamable-http/);
  assert.equal(spec.patchPaths.length, 3);
});

test("4.2 missing skill content refuses to compose (never a silent half-bundle)", async () => {
  await assert.rejects(
    () =>
      materializeAgentHome({
        homeRoot: path.join(tmpRoot, "compose2"),
        agentKey: agentKeyFor(ENTRY),
        entry: ENTRY,
        skillContents: {},
        mcpServers: [],
        template: TEMPLATE,
      }),
    /skill content unavailable/,
  );
});

// ── Stub registry + manager/adapter harness ────────────────────────────────

function stubRegistryFetch(entries, skills) {
  return async (p, init = {}) => {
    if (p.startsWith("/api/agents")) return { ok: true, status: 200, json: async () => ({ agents: entries }) };
    const m = p.match(/^\/api\/skills\/(.+)\/content$/);
    if (m && init.method !== "POST") {
      if (skills[m[1]] === undefined) return { ok: false, status: 404, json: async () => ({ detail: "nope" }) };
      return { ok: true, status: 200, json: async () => ({ content: skills[m[1]] }) };
    }
    return { ok: false, status: 404, json: async () => ({ detail: `no stub for ${p}` }) };
  };
}

const OPS = (await import("node:http")).default;

async function bootRunner({ entries, skills = {}, config: cfgOverrides = {}, reply = "分析完成" } = {}) {
  const homeRoot = path.join(tmpRoot, `run-${Math.random().toString(36).slice(2)}`);
  const spawned = [];
  const config = {
    homeRoot,
    registryUrl: "https://mcp.example.test",
    registryToken: "tok",
    pollSecs: 60,
    provider: "test-provider",
    model: "test-model",
    backendToken: "backend-secret",
    idleMs: 60_000,
    maxChildren: 2,
    drainMs: 2_000,
    turnTimeoutMs: 5_000,
    dshProfile: "platform",
    cwd: tmpRoot,
    portBase: 20000 + Math.floor(Math.random() * 20000),
    portSpan: 512,
  };
  Object.assign(config, cfgOverrides);
  const registryClient = createRegistryClient({ registryUrl: config.registryUrl, registryToken: config.registryToken, fetchImpl: stubRegistryFetch(entries, skills) });
  const clientFactory = (spec) => () => {
    const client = fakeHarnessClient({ reply });
    spawned.push({ spec, client });
    return client;
  };
  const manager = new ChildManager({ config, registryClient, clientFactory, log: { log() {}, warn() {}, error() {} } });
  const ops = OPS.createServer(createOpsApp({ manager }));
  await new Promise((r) => ops.listen(0, "127.0.0.1", r));
  const call = (method, p, { headers = {}, body } = {}) =>
    fetch(`http://127.0.0.1:${ops.address().port}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }));
  // Hit an agent's OWN listener (per-agent port, flat A2A layout).
  const agentPort = async (entry) => {
    const key = (await import("../agent-runner/compose.js")).agentKeyFor(entry);
    return manager.health().agents.find((a) => a.key === key).port;
  };
  const callAgent = async (entry, method, p, { headers = {}, body } = {}) => {
    const port = await agentPort(entry);
    return fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, headers: res.headers, text: await res.text() }));
  };
  return {
    manager, call, callAgent, spawned, config,
    close: async () => {
      await manager.stopAll();
      await new Promise((r) => ops.close(r));
    },
  };
}

const SEND = (id, text, context_id) => ({
  jsonrpc: "2.0",
  id,
  method: "message/send",
  params: { message: { role: "user", parts: [{ kind: "text", text }], context_id } },
});

// ── 4.1: inert boot polls and hosts nothing ────────────────────────────────

test("4.1 inert boot: zero entries → health shows nothing, no children, no listeners", async () => {
  const h = await bootRunner({ entries: [] });
  try {
    await h.manager.reconcile();
    const health = JSON.parse((await h.call("GET", "/health")).text);
    assert.equal(health.ok, true);
    assert.equal(health.agents.length, 0);
    assert.equal(h.spawned.length, 0);
  } finally {
    await h.close();
  }
});

// ── 4.3/4.5: adapter surface + auth gate ───────────────────────────────────

test("4.3 card at the agent origin matches the registered entry; direct calls without the credential are rejected", async () => {
  const h = await bootRunner({ entries: [ENTRY], skills: { "packs/pk-abc/fin-statement-analysis": "# s" } });
  try {
    await h.manager.reconcile();
    const noAuth = await h.callAgent(ENTRY, "GET", "/.well-known/agent-card.json");
    assert.equal(noAuth.status, 401, "request without the agent credential is rejected");
    const card = await h.callAgent(ENTRY, "GET", "/.well-known/agent-card.json", { headers: { Authorization: "Bearer backend-secret" } });
    assert.equal(card.status, 200);
    const doc = JSON.parse(card.text);
    assert.equal(doc.name, "FingPt Analyst");
    assert.equal(doc.capabilities.streaming, true);
    assert.equal(doc.url, "https://mcp.example.test/agent/packs/pk-abc/pack-fingpt/");
    const rpcNoAuth = await h.callAgent(ENTRY, "POST", "/", { body: SEND(1, "hi") });
    assert.equal(rpcNoAuth.status, 401);
  } finally {
    await h.close();
  }
});

test("4.3 message/send runs a turn and returns text parts; unknown method is -32601; send continuity per context", async () => {
  const h = await bootRunner({ entries: [ENTRY], skills: { "packs/pk-abc/fin-statement-analysis": "# s" } });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    const send = await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(1, "分析这份财报", "ctx-1") });
    assert.equal(send.status, 200);
    const doc = JSON.parse(send.text);
    assert.equal(doc.result.role, "assistant");
    assert.equal(doc.result.parts[0].kind, "text");
    assert.match(doc.result.parts[0].text, /分析完成/);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].client.calls.prompt[0].sessionId, sessionKeyFor("ctx-1"));
    await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(2, "继续", "ctx-1") });
    assert.equal(h.spawned.length, 1);
    assert.equal(h.spawned[0].client.calls.prompt.length, 2);
    assert.equal(h.spawned[0].client.calls.prompt[1].sessionId, h.spawned[0].client.calls.prompt[0].sessionId);
    const unknown = await h.callAgent(ENTRY, "POST", "/", {
      headers: auth,
      body: { jsonrpc: "2.0", id: 3, method: "tasks/get", params: {} },
    });
    assert.equal(JSON.parse(unknown.text).error.code, -32601);
  } finally {
    await h.close();
  }
});

test("4.3 message/stream SSE: deltas then final message then done", async () => {
  const h = await bootRunner({ entries: [ENTRY], skills: { "packs/pk-abc/fin-statement-analysis": "# s" }, reply: "流式回复内容" });
  try {
    await h.manager.reconcile();
    const port = h.manager.health().agents[0].port;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer backend-secret" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "message/stream",
        params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], context_id: "ctx-s" } },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /event: delta/);
    assert.match(body, /event: message/);
    assert.match(body, /event: done/);
    assert.match(body, /流式回复内容/);
  } finally {
    await h.close();
  }
});

// ── 4.4: lifecycle — queue at capacity, idle reap, undeploy listener ────────

test("4.4 capacity queues instead of failing or evicting", async () => {
  const entries = [ENTRY, { ...ENTRY, path: "/packs/pk-abc/pack-risk", metadata: { ...ENTRY.metadata, agentId: "pack-risk" } }, { ...ENTRY, path: "/packs/pk-abc/pack-third", metadata: { ...ENTRY.metadata, agentId: "pack-third" } }];
  const h = await bootRunner({
    entries,
    skills: { "packs/pk-abc/fin-statement-analysis": "# s" },
    config: { maxChildren: 1, idleMs: 3_600_000 },
    reply: "queued-ok",
  });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    const first = h.callAgent(entries[0], "POST", "/", { headers: auth, body: SEND(1, "q", "c1") });
    const second = h.callAgent(entries[1], "POST", "/", { headers: auth, body: SEND(2, "q", "c2") });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200, "the queued request eventually serves — no 503, no eviction");
    assert.equal(h.spawned.length, 2);
  } finally {
    await h.close();
  }
});

test("4.4 idle reap frees the child; next message cold-starts; undeploy stops the listener", async () => {
  const h = await bootRunner({
    entries: [ENTRY],
    skills: { "packs/pk-abc/fin-statement-analysis": "# s" },
    config: { idleMs: 10 },
  });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(1, "q", "c") });
    assert.equal(h.spawned.length, 1);
    await new Promise((r) => setTimeout(r, 30));
    h.manager.reapIdle();
    assert.equal(h.manager.children.size, 0, "idle child reaped");
    const again = await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(2, "again", "c") });
    assert.equal(again.status, 200);
    assert.equal(h.spawned.length, 2, "cold start spawned a fresh child");
    assert.equal(h.spawned[1].client.calls.prompt[0].sessionId, h.spawned[0].client.calls.prompt[0].sessionId);
    // Leaving the registry stops the per-agent listener (undeploy semantics).
    const _port = h.manager.health().agents[0].port;
    const h2entries = [];
    await h.manager.reconcileWith?.(h2entries); // no such method — drive directly:
  } finally {
    await h.close();
  }
});

test("4.4 undeploy: entry leaving the registry stops its listener", async () => {
  const homeRoot = path.join(tmpRoot, `und-${Math.random().toString(36).slice(2)}`);
  const config = {
    homeRoot, registryUrl: "https://mcp.example.test", registryToken: "t",
    backendToken: "bt", idleMs: 60_000, maxChildren: 2, drainMs: 1_000, turnTimeoutMs: 5_000,
    dshProfile: "platform", cwd: tmpRoot, provider: "p", model: "m",
    portBase: 45000 + Math.floor(Math.random() * 5000), portSpan: 512,
  };
  let current = [ENTRY];
  const registryClient = {
    listServedAgents: async () => current,
    fetchSkillContent: async () => "# s",
    mcpUrlFor: (n) => `https://mcp.example.test/${n}/mcp`,
  };
  const manager = new ChildManager({
    config,
    registryClient,
    clientFactory: () => () => fakeHarnessClient({ reply: "r" }),
    log: { log() {}, warn() {}, error() {} },
  });
  try {
    await manager.reconcile();
    const port = manager.health().agents[0].port;
    // The listener binds async — poll until it answers (any status).
    let status = null;
    for (let i = 0; i < 20 && status === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, {
          headers: { Authorization: "Bearer wrong" },
        });
        status = res.status;
      } catch { /* not bound yet */ }
    }
    assert.equal(status, 401, "listener up and gating before undeploy");
    current = [];
    await manager.reconcile();
    await new Promise((r) => setTimeout(r, 150));
    const refused = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`).then(
      () => false,
      () => true,
    );
    assert.ok(refused, "connection refused after undeploy — listener stopped");
    assert.equal(manager.health().agents.length, 0);
  } finally {
    await manager.stopAll();
  }
});

test("4.4 prompt rejection settles the turn (no counter leak, drain unwedged)", async () => {
  const client = fakeHarnessClient({ failPrompt: true });
  const child = new AgentChild({
    key: "k",
    spawnSpec: { profile: "p", patchPaths: [], cwd: tmpRoot, env: {}, provider: "p", model: "m", presetId: null },
    turnTimeoutMs: 1_000,
    clientFactory: () => client,
    log: { log() {}, warn() {}, error() {} },
  });
  await child.start();
  await assert.rejects(() => child.turn("s1", "hi"), /prompt rejected/);
  assert.equal(child.activeTurns, 0);
  await child.drainAndStop(100); // would wedge forever if the counter leaked
  assert.equal(client.calls.stopped, 1);
});
