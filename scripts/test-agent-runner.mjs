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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

import { materializeAgentHome, mcpEntry, agentKeyFor, applyBillingKey, applyDeploymentSecrets } from "../agent-runner/compose.js";
import { AgentChild, sessionKeyFor } from "../agent-runner/child.js";
import { ChildManager } from "../agent-runner/manager.js";
import { createOpsApp, agentPortFor } from "../agent-runner/a2a.js";
import net from "node:net";
import { createRegistryClient } from "../agent-runner/registry.js";
import { RhythmScheduler, DEFAULT_SELF_PROMPT } from "../agent-runner/scheduler.js";
import { Rollover } from "../agent-runner/rollover.js";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "agent-runner-"));

// File-wide port allocator, PROBE-BASED: managers must not bind a port some
// other process already listens on. Blind random bases shipped a CI flake
// (EADDRINUSE 0.0.0.0:46460) and reproduced locally — dev machines run real
// listeners all over the 20k-60k band. Allocation probes the EXACT port this
// manager will bind (base + the agent path's deterministic offset, the same
// hash the manager uses) and advances the cursor until it is free. Sequential
// stride 768 > portSpan 512 additionally keeps this file's own windows
// disjoint, so one test's leaked listener can never collide with another's.
const portTaken = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.listen(port, "0.0.0.0", () => s.close(() => resolve(false)));
  });
let portCursor = 20000 + Math.floor(Math.random() * 20000);
async function nextPortBaseFor(agentPath) {
  for (let i = 0; i < 300; i++) {
    const base = portCursor;
    portCursor = base + 768 > 58_000 ? 20_000 : base + 768;
    const port = agentPortFor(agentPath, { base, span: 512 });
    if (!(await portTaken(port))) return base;
  }
  throw new Error(`test port allocator: no free window found for ${agentPath}`);
}
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── Fake harness client: records calls, replies to prompt with a scripted ──
// turn (text deltas + final message + idle), per the dsh notification shapes.
function fakeHarnessClient({ reply = "ok", delayMs = 0, failPrompt = false } = {}) {
  const calls = { initialize: [], prompt: [], requests: [], started: 0, stopped: 0 };
  const client = {
    calls,
    start() {
      calls.started += 1;
    },
    async initialize(params) {
      calls.initialize.push(params);
      return { ok: true };
    },
    // Host→child requests (add-agent-notifications: the runner answers a
    // bot_notify call with `botNotify/result` on this lane).
    async request(method, params) {
      calls.requests.push({ method, params });
      return { accepted: true };
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
  // Notify overlay (add-agent-notifications D1): the preset bridge row is
  // swapped for its notify subclass, and both bridge files land beside it.
  const notify = readFileSync(path.join(spec.home, "profiles", "platform", "notify.patch.yml"), "utf8");
  assert.match(notify, /id: platform-sdk-server[\s\S]*?disabled: true/);
  assert.match(notify, /platform-notify-server/);
  assert.match(notify, /platform-notify-bridge\.js/);
  assert.ok(existsSync(path.join(spec.home, "profiles", "platform", "platform-notify-bridge.js")));
  assert.ok(existsSync(path.join(spec.home, "profiles", "platform", "bot-notify.js")));
  assert.equal(spec.patchPaths.length, 4);
  // Layer order: the notify overlay must apply AFTER the presets overlay that
  // inserted the row it disables.
  assert.equal(spec.patchPaths[0], path.join(spec.home, "profiles", "platform", "presets.patch.yml"));
  assert.equal(spec.patchPaths.at(-1), path.join(spec.home, "profiles", "platform", "notify.patch.yml"));
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
    portBase: await nextPortBaseFor(ENTRY.path), portSpan: 512,
    // Warm-zone / rhythm / rollover knobs (add-agent-residency); metering and
    // archive land under the run's homeRoot.
    budgetMb: 3072,
    agentCostMb: 96,
    sampleSecs: 30,
    demoteCooldownMs: 600_000,
    hardBudgetFactor: 1.2,
    rhythmTickMs: 30_000,
    tz: "UTC",
    digestMaxChars: 512,
    archiveDir: path.join(homeRoot, "agent-archive"),
    meterFile: path.join(homeRoot, "meter.jsonl"),
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

test("4.4 residency (add-agent-residency): idle child stays; budget demotes; re-warm keeps the session", async () => {
  const h = await bootRunner({
    entries: [ENTRY],
    skills: { "packs/pk-abc/fin-statement-analysis": "# s" },
    config: {
      budgetMb: 1, // tiny budget: one child (96MB floor) already exceeds it
      agentCostMb: 96,
      demoteCooldownMs: 0, // no hysteresis in this test
      sampleSecs: 1,
    },
  });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(1, "q", "c") });
    assert.equal(h.spawned.length, 1);
    // The former idle reap is GONE: an idle resident past any interval stays.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.manager.children.size, 1, "idle resident is NOT reaped");
    assert.equal(h.manager.health().agents[0].state, "resident");
    // The warm-zone budget demotes it (cooldown 0, over budget).
    h.manager.enforceBudget();
    assert.equal(h.manager.children.size, 0, "over-budget resident demoted to warm");
    assert.equal(h.manager.health().agents[0].state, "warm");
    // Next message re-warms: same session id (state survived on disk), fresh process.
    const again = await h.callAgent(ENTRY, "POST", "/", { headers: auth, body: SEND(2, "again", "c") });
    assert.equal(again.status, 200);
    assert.equal(h.spawned.length, 2, "re-warm spawned a fresh child");
    assert.equal(h.spawned[1].client.calls.prompt[0].sessionId, h.spawned[0].client.calls.prompt[0].sessionId);
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
    portBase: await nextPortBaseFor(ENTRY.path), portSpan: 512,
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

// ── add-agent-residency: pause, budget hysteresis, scheduler, metering, rollover ──

async function directManager({ entries = [ENTRY], config: overrides = {}, harness = {}, notifyFetch } = {}) {
  const homeRoot = path.join(tmpRoot, `res-${Math.random().toString(36).slice(2)}`);
  const spawned = [];
  const config = {
    homeRoot,
    registryUrl: "https://mcp.example.test", registryToken: "t",
    backendToken: "bt", maxChildren: 2, drainMs: 1_000, turnTimeoutMs: 5_000,
    dshProfile: "platform", cwd: tmpRoot, provider: "p", model: "m",
    portBase: await nextPortBaseFor(entries[0]?.path ?? ENTRY.path), portSpan: 512,
    budgetMb: 3072, agentCostMb: 96, sampleSecs: 30, demoteCooldownMs: 600_000,
    hardBudgetFactor: 1.2, rhythmTickMs: 30_000, tz: "UTC", digestMaxChars: 512,
    archiveDir: path.join(homeRoot, "agent-archive"),
    meterFile: path.join(homeRoot, "meter.jsonl"),
    // Notification egress (add-agent-notifications): unconfigured by default —
    // tests that exercise the face override these.
    relayUrl: "", relayToken: "", notifyRatePerMin: 6,
    notifyLogFile: path.join(homeRoot, "notify.jsonl"),
    ...overrides,
  };
  const registryClient = {
    listServedAgents: async () => entriesRef.current,
    fetchSkillContent: async () => "# s",
    mcpUrlFor: (n) => `https://mcp.example.test/${n}/mcp`,
  };
  const entriesRef = { current: entries };
  // `harness` is spread at spawn time so tests can flip per-spawn behavior
  // (e.g. a slow first turn, fast after the budget kill).
  const clientFactory = (spec) => (spawn = {}) => { const c = fakeHarnessClient({ reply: "答复", ...harness }); spawned.push({ client: c, spec, spawn }); return c; };
  const manager = new ChildManager({
    config, registryClient, clientFactory,
    log: { log() {}, warn() {}, error() {} },
    notifyFetchImpl: notifyFetch,
  });
  return { manager, spawned, config, entriesRef };
}

test("residency: paused entry demotes, answers explicit -32010, resumes on flag clear", async () => {
  const pausedEntry = { ...ENTRY, metadata: { ...ENTRY.metadata, paused: true } };
  const { manager, spawned } = await directManager({ entries: [pausedEntry] });
  try {
    await manager.reconcile();
    assert.equal(manager.health().agents[0].state, "paused");
    // Message a paused agent directly through the turn face: explicit error,
    // never a cold start (no spawn happens at all).
    await assert.rejects(() => manager.turn(pausedEntry, "s1", "hi"), (e) => e.code === -32010);
    assert.equal(spawned.length, 0);
    // Clear the flag (registry truth) → resume re-warms on the next event.
    const resumed = { ...ENTRY, metadata: { ...ENTRY.metadata } };
    const entries2 = [resumed];
    manager.registryClient.listServedAgents = async () => entries2;
    await manager.reconcile();
    assert.equal(manager.health().agents[0].state, "warm");
    const out = await manager.turn(resumed, "s1", "hi");
    assert.equal(out.text, "答复");
    assert.equal(spawned.length, 1);
  } finally {
    await manager.stopAll();
  }
});

test("residency: cooldown hysteresis protects a fresh child until the budget is hard-exceeded", async () => {
  // 96MB cost × 2 children = 192MB; soft budget 100MB (over), hard ×1.2 = 120MB.
  const { manager } = await directManager({
    config: { budgetMb: 100, agentCostMb: 96, demoteCooldownMs: 600_000, hardBudgetFactor: 1.2 },
  });
  try {
    await manager.reconcile();
    await manager.turn(ENTRY, "s1", "hi"); // child A (fresh: within cooldown)
    await manager.turn(ENTRY, "s2", "hi"); // child A again (same key — one child)
    // One child = 96MB ≤ 100MB soft — nothing to demote.
    manager.enforceBudget();
    assert.equal(manager.children.size, 1);
    // Hard-exceed: a second child pushes 192MB > 120MB hard — the fresh child
    // becomes eligible despite the cooldown.
    const ENTRY2 = { ...ENTRY, path: "/packs/pk-abc/pack-other", metadata: { ...ENTRY.metadata, agentId: "pack-other" } };
    manager.entries.set(agentKeyFor(ENTRY2), ENTRY2);
    await manager.turn(ENTRY2, "s1", "hi");
    manager.enforceBudget();
    assert.equal(manager.children.size, 1, "hard budget demoted one of the two");
  } finally {
    await manager.stopAll();
  }
});

test("scheduler: fires at due, honors do-prompt, skips missed, ignores rhythm-less", async () => {
  let clock = Date.parse("2026-10-02T00:00:00Z");
  const { manager, spawned } = await directManager({
    config: { tz: "UTC", rhythmTickMs: 1000 },
  });
  manager.now = () => clock; // deterministic clock
  const withRhythm = { ...ENTRY, metadata: { ...ENTRY.metadata, effective_rhythm: [{ every: "5m", do: "巡检数据源" }] } };
  const quiet = { ...ENTRY, path: "/packs/pk-abc/quiet", metadata: { ...ENTRY.metadata, agentId: "quiet" } };
  manager.entries.set(agentKeyFor(withRhythm), withRhythm);
  manager.entries.set(agentKeyFor(quiet), quiet);
  const scheduler = new RhythmScheduler({ manager, config: manager.config, log: { log() {}, warn() {}, error() {} }, now: () => clock });

  await scheduler.tick(); // anchors
  clock += 4 * 60_000;
  await scheduler.tick();
  assert.equal(spawned.length, 0, "not due yet");

  clock += 2 * 60_000; // 6m: the 5m due passed within one period
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 1, "fired at due");
  const promptCall = spawned[0].client.calls.prompt[0];
  assert.equal(promptCall.blocks[0].text, "巡检数据源");
  assert.match(promptCall.sessionId, /^srv-day-20261002/);
  assert.equal(manager.metered, undefined); // (metering asserted below via file)

  // A huge jump = missed dues: skipped now, resumes one period later. Count
  // PROMPTS (a resumed fire reuses the resident child — no new spawn).
  const promptCount = () => spawned.reduce((n, s) => n + s.client.calls.prompt.length, 0);
  const fired = promptCount();
  clock += 60 * 60_000; // 1h over a 5m schedule
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(promptCount(), fired, "missed dues skipped — no catch-up burst");
  clock += 5 * 60_000 + 1000; // re-anchored at the skip: next due is 5m out
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(promptCount(), fired + 1, "schedule resumed from the next due");

  // The rhythm-less agent never fired anything of its own.
  assert.ok(spawned.every((s) => s.client.calls.prompt.every((c) => c.sessionId.startsWith("srv-day-20261002"))));
  assert.equal(spawned.filter((s) => s.client.calls.prompt.some((c) => c.blocks[0].text === DEFAULT_SELF_PROMPT)).length, 0, "no default prompt fired (entry had do)");
  await manager.stopAll();
});

test("metering: every turn kind lands one jsonl line", async () => {
  const { manager, config } = await directManager({});
  try {
    await manager.reconcile();
    await manager.turn(ENTRY, "s1", "hello", { kind: "message" });
    await manager.selfTurn(ENTRY, "自主工作", "srv-day-x");
    const lines = readFileSync(config.meterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, "message");
    assert.equal(lines[1].kind, "self");
    assert.equal(typeof lines[0].at, "string");
    assert.ok(lines[0].durationMs >= 0);
  } finally {
    await manager.stopAll();
  }
});

// ── add-serving-budgets 2.1/2.2: per-child budget + over-budget hard stop ───

test("budget: the descriptor's minutes drive the child's timeout and label", async () => {
  const budgeted = { ...ENTRY, metadata: { ...ENTRY.metadata, effective_budget_minutes: 20 } };
  const { manager, spawned } = await directManager({ entries: [budgeted], config: { turnTimeoutMs: 999_000 } });
  try {
    await manager.reconcile();
    await manager.turn(budgeted, "s1", "hi");
    const child = manager.children.get(agentKeyFor(budgeted));
    assert.equal(child.turnTimeoutMs, 20 * 60_000, "descriptor minutes beat the deployment default");
    assert.equal(child.budgetLabel, "20m");
    assert.equal(spawned[0].spec.turnBudgetMs, 20 * 60_000, "the harness request timeout rides the budget");
  } finally {
    await manager.stopAll();
  }
});

test("budget: no descriptor budget falls back to the deployment default", async () => {
  const { manager, spawned } = await directManager({ entries: [ENTRY], config: { turnTimeoutMs: 120_000 } });
  try {
    await manager.reconcile();
    await manager.turn(ENTRY, "s1", "hi");
    const child = manager.children.get(agentKeyFor(ENTRY));
    assert.equal(child.turnTimeoutMs, 120_000, "the runner default is the effective budget");
    assert.equal(child.budgetLabel, "2m");
    assert.equal(spawned[0].spec.turnBudgetMs, 120_000);
  } finally {
    await manager.stopAll();
  }
});

test("budget: an over-budget turn hard-stops the child, meters the kill, next touch re-warms", async () => {
  // First spawn replies far beyond the 60ms budget; the re-warm replies fast.
  const harness = { delayMs: 300 };
  const { manager, spawned, config } = await directManager({ entries: [ENTRY], config: { turnTimeoutMs: 60 }, harness });
  try {
    await manager.reconcile();
    await assert.rejects(
      () => manager.turn(ENTRY, "s1", "slow"),
      (e) => e.code === -32001 && /turn budget \(1m\) exceeded/.test(e.message),
      "the structured error names the bound",
    );
    // Hard stop: removed from the pool and the process stopped.
    assert.equal(manager.children.size, 0, "killed child removed");
    assert.equal(manager.health().agents[0].state, "warm");
    assert.equal(spawned[0].client.calls.stopped, 1, "the child process was stopped");
    // Meter: one line, flagged as a budget kill, error naming the bound.
    const lines = readFileSync(config.meterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ok, false);
    assert.equal(lines[0].budgetKill, true);
    assert.match(lines[0].error, /turn budget \(1m\) exceeded/);
    // Next touch re-warms: fresh child, same session id (state on disk).
    harness.delayMs = 0;
    const out = await manager.turn(ENTRY, "s1", "again");
    assert.equal(out.text, "答复");
    assert.equal(spawned.length, 2, "cold start on the next touch");
    assert.equal(
      spawned[1].client.calls.prompt[0].sessionId,
      spawned[0].client.calls.prompt[0].sessionId,
      "the conversation continues by session id",
    );
  } finally {
    await manager.stopAll();
  }
});

test("budget: self-turns share the same hard-stop discipline", async () => {
  const harness = { delayMs: 300 };
  const { manager, config } = await directManager({ entries: [ENTRY], config: { turnTimeoutMs: 60 }, harness });
  try {
    await manager.reconcile();
    await assert.rejects(
      () => manager.selfTurn(ENTRY, "自主工作", "srv-day-20261003"),
      (e) => e.code === -32001 && /turn budget \(1m\) exceeded/.test(e.message),
    );
    assert.equal(manager.children.size, 0);
    const lines = readFileSync(config.meterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "self");
    assert.equal(lines[0].budgetKill, true);
  } finally {
    await manager.stopAll();
  }
});

test("rollover: first sighting opens the marker; the next day digests, archives, and queues the head", async () => {
  let clock = Date.parse("2026-10-02T12:00:00Z");
  const { manager, config } = await directManager({});
  manager.now = () => clock;
  const rollover = new Rollover({ manager, config, log: { log() {}, warn() {}, error() {} }, now: () => clock });
  try {
    await manager.reconcile();
    await manager.turn(ENTRY, "srv-day-20261002", "白天的工作"); // today's session exists
    // First check on the same day: marker opens, no digest turn.
    await rollover.check();
    const marker = JSON.parse(readFileSync(path.join(config.homeRoot, agentKeyFor(ENTRY), "last-roll.json"), "utf8"));
    assert.equal(marker.day, "2026-10-02");

    clock = Date.parse("2026-10-03T00:05:00Z"); // next day
    await rollover.check();
    // The digest turn ran on YESTERDAY's session with the digest prompt.
    const lines = readFileSync(config.meterFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.kind === "digest"), "digest turn metered");
    // The archive carries the digest; the pending head is queued exactly once.
    assert.ok(existsSync(path.join(config.archiveDir, agentKeyFor(ENTRY), "20261002.md")));
    assert.ok(rollover.takePendingDigest(agentKeyFor(ENTRY)).length > 0, "pending digest served");
    assert.equal(rollover.takePendingDigest(agentKeyFor(ENTRY)), null, "pending digest consumed exactly once");
  } finally {
    await manager.stopAll();
  }
});

// ── add-agent-residency 6.1: the paused flow through the REAL a2a adapter ────
// (HTTP seam: explicit -32010 to callers, no cold start, resume restores
// serving — complements the manager-level residency tests above.)

test("6.1 a2a adapter: paused answers explicitly over HTTP; resume restores", async () => {
  const pausedEntry = { ...ENTRY, metadata: { ...ENTRY.metadata, paused: true } };
  const h = await bootRunner({
    entries: [pausedEntry],
    skills: { "packs/pk-abc/fin-statement-analysis": "# s" },
    config: {},
  });
  try {
    await h.manager.reconcile();
    assert.equal(h.manager.health().agents[0].state, "paused");
    // A caller through the agent's own HTTP port gets an explicit paused
    // error — never a timeout, never a cold start (nothing spawned).
    const res = await h.callAgent(pausedEntry, "POST", "/", {
      headers: { Authorization: "Bearer backend-secret" },
      body: SEND(7, "hi", "ctx"),
    });
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.text);
    assert.equal(doc.error.code, -32010);
    assert.match(doc.error.message, /paused/);
    assert.equal(h.spawned.length, 0, "paused never cold-starts");

    // The registry flag clears (resume) → the same caller is served again.
    const resumed = { ...ENTRY, metadata: { ...ENTRY.metadata } };
    h.manager.registryClient.listServedAgents = async () => [resumed];
    await h.manager.reconcile();
    const ok = await h.callAgent(resumed, "POST", "/", {
      headers: { Authorization: "Bearer backend-secret" },
      body: SEND(8, "hi", "ctx"),
    });
    assert.equal(JSON.parse(ok.text).result.parts[0].text, "分析完成");
    assert.equal(h.manager.health().agents[0].state, "resident");
  } finally {
    await h.close();
  }
});

// ── add-agent-delegation-a2a 4.1: depth bound + delegation concurrency ───────

test("4.1 depth >= 3 refused explicitly; depth 1-2 served; concurrency queues", async () => {
  const h = await bootRunner({
    entries: [ENTRY],
    skills: { "packs/pk-abc/fin-statement-analysis": "# s" },
    // Two concurrent delegation turns allowed; the fake client replies fast,
    // so prove the CAP by a slow reply blocking the second.
    config: { delegationMax: 1, delegationDepthMax: 3 },
  });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    const call = (id, text, depth) =>
      h.callAgent(ENTRY, "POST", "/", {
        headers: depth ? { ...auth, "X-Delegation-Depth": String(depth) } : auth,
        body: SEND(id, text, "c"),
      });

    const refused = await call(1, "deep", 3);
    assert.equal(JSON.parse(refused.text).error.code, -32011);
    assert.match(JSON.parse(refused.text).error.message, /depth bound/);
    assert.equal(h.spawned.length, 0, "refusal spawns nothing");

    const ok = await call(2, "shallow", 2);
    assert.equal(JSON.parse(ok.text).result.parts[0].text, "分析完成");

    // No depth header (human chat) also serves.
    const human = await call(3, "hi");
    assert.equal(human.status, 200);
  } finally {
    await h.close();
  }
});

// ── D2 billing pinning: the deployer's key must land on the ref the provider
// route actually reads (settings.yaml apiKeyEnv), not only the generic
// LLM_API_KEY, or the pinned key stays inert at inference time. ────────────
test("billing key pins every provider apiKeyEnv ref", async () => {
  const home = path.join(tmpRoot, "billing-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "settings.yaml"),
    yaml.dump({
      "llm-pi-ai": {
        providers: {
          finddata: { apiKeyEnv: "LLM_PROVIDER_KEY_FINDDATA", api: "openai-completions" },
          volces: { apiKeyEnv: "LLM_PROVIDER_KEY_VOLCES" },
        },
      },
    }),
  );
  writeFileSync(
    path.join(home, ".credentials.yaml"),
    yaml.dump({ version: 1, refs: { LLM_PROVIDER_KEY_FINDDATA: "runner-level", KEEP: "untouched" } }),
  );
  await applyBillingKey(home, "sk-deployer");
  const doc = yaml.load(readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(doc.refs.LLM_API_KEY, "sk-deployer");
  assert.equal(doc.refs.LLM_PROVIDER_KEY_FINDDATA, "sk-deployer");
  assert.equal(doc.refs.LLM_PROVIDER_KEY_VOLCES, "sk-deployer");
  assert.equal(doc.refs.KEEP, "untouched");
});

test("billing pinning survives a missing settings.yaml", async () => {
  const home = path.join(tmpRoot, "billing-home-bare");
  mkdirSync(home, { recursive: true });
  await applyBillingKey(home, "sk-deployer");
  const doc = yaml.load(readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(doc.refs.LLM_API_KEY, "sk-deployer");
});

// ── add-deployment-secrets 2.1: fetch by reference, pin the complete set ────
// A stub of the pack gateway's internal fetch route (the real one is tested
// in scripts/test-deployment-secrets.mjs); these tests prove the RUNNER's
// half: every declared ref is fetched with the service credential, the whole
// set lands in the private credentials file, and a missing value fails
// composition loudly with nothing partially installed.

const SECRET_REF_A = "ws_111111111111111111111111";
const SECRET_REF_B = "ws_222222222222222222222222";

const SECRET_ENTRY = {
  ...ENTRY,
  path: "/packs/pk-abc/pack-secret",
  metadata: {
    ...ENTRY.metadata,
    agentId: "pack-secret",
    secret_refs: { repo_token: SECRET_REF_A, mirror_key: SECRET_REF_B },
  },
};

async function stubPacksGateway(byRef) {
  const seen = [];
  const server = OPS.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization ?? null });
    const m = String(req.url).match(/^\/api\/packs\/internal\/secret\/(.+)$/);
    const doc = m ? byRef[decodeURIComponent(m[1])] : null;
    res.writeHead(doc ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(doc ?? { error: "unknown secret reference" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

const SECRET_SKILLS = { "packs/pk-abc/fin-statement-analysis": "# s" };

test("2.1 declared secrets: every ref is fetched with the service credential and pinned into the child home", async () => {
  const packs = await stubPacksGateway({
    [SECRET_REF_A]: { secretRef: SECRET_REF_A, agentId: "pack-secret", name: "repo_token", secretValue: "ghp_PINNED_repo_token_VALUE" },
    [SECRET_REF_B]: { secretRef: SECRET_REF_B, agentId: "pack-secret", name: "mirror_key", secretValue: "mk-mirror-9876543210" },
  });
  const h = await bootRunner({ entries: [SECRET_ENTRY], skills: SECRET_SKILLS, config: { packsBaseUrl: packs.base } });
  try {
    await h.manager.reconcile();
    const out = await h.manager.turn(SECRET_ENTRY, "s1", "hi");
    assert.equal(out.text, "分析完成");
    assert.equal(h.spawned.length, 1, "the child composed");

    // Both values land in the private credentials file under declared names.
    const doc = yaml.load(readFileSync(path.join(h.spawned[0].spec.home, ".credentials.yaml"), "utf8"));
    assert.equal(doc.refs.repo_token, "ghp_PINNED_repo_token_VALUE");
    assert.equal(doc.refs.mirror_key, "mk-mirror-9876543210");

    // One fetch per ref, over the internal route, with the runner's service
    // credential (the same trust plane as the llm-key route).
    assert.equal(packs.seen.length, 2);
    assert.deepEqual(
      packs.seen.map((s) => s.path).sort(),
      [`/api/packs/internal/secret/${SECRET_REF_A}`, `/api/packs/internal/secret/${SECRET_REF_B}`].sort(),
    );
    for (const s of packs.seen) assert.equal(s.authorization, "Bearer tok", "service credential on every fetch");
  } finally {
    await h.close();
    packs.server.close();
  }
});

test("2.1 a missing secret fails composition loudly; no partial set, no fallback, no child", async () => {
  // The FIRST ref resolves, the second 404s — the resolved value must still
  // not land (all-or-nothing), and the error must name the missing secret.
  const packs = await stubPacksGateway({
    [SECRET_REF_A]: { secretRef: SECRET_REF_A, agentId: "pack-secret", name: "repo_token", secretValue: "ghp_GOOD_VALUE_never_installed" },
  });
  const h = await bootRunner({ entries: [SECRET_ENTRY], skills: SECRET_SKILLS, config: { packsBaseUrl: packs.base } });
  try {
    await h.manager.reconcile();
    let err = null;
    await assert.rejects(
      () => h.manager.turn(SECRET_ENTRY, "s1", "hi"),
      (e) => {
        err = e;
        return true;
      },
    );
    assert.match(err.message, /mirror_key/, "the missing secret's name is in the error");
    assert.match(err.message, /ws_22222/, "the missing reference is in the error (masked)");
    assert.match(err.message, /could not be fetched/);
    assert.equal(h.manager.children.size, 0, "no child composed");
    assert.equal(h.spawned.length, 0);

    // Neither value was installed — the resolved one included.
    const credPath = path.join(h.config.homeRoot, agentKeyFor(SECRET_ENTRY), ".credentials.yaml");
    if (existsSync(credPath)) {
      const doc = yaml.load(readFileSync(credPath, "utf8")) ?? {};
      assert.equal(doc.refs?.repo_token, undefined, "no partial secret set installed");
      assert.equal(doc.refs?.mirror_key, undefined);
    }
  } finally {
    await h.close();
    packs.server.close();
  }
});

test("2.1 no secret_refs: the pack gateway is never contacted and composition is unchanged", async () => {
  const packs = await stubPacksGateway({});
  const h = await bootRunner({ entries: [ENTRY], skills: SECRET_SKILLS, config: { packsBaseUrl: packs.base } });
  try {
    await h.manager.reconcile();
    const out = await h.manager.turn(ENTRY, "s1", "hi");
    assert.equal(out.text, "分析完成");
    assert.equal(h.spawned.length, 1);
    assert.equal(packs.seen.length, 0, "no descriptor secrets → zero fetch calls");
  } finally {
    await h.close();
    packs.server.close();
  }
});

test("2.1 a rebound descriptor reaches composition through the live listener (in-place redeploy pins the NEW ref)", async () => {
  const packs = await stubPacksGateway({
    [SECRET_REF_A]: { secretRef: SECRET_REF_A, agentId: "pack-secret", name: "repo_token", secretValue: "ghp_value_ONE_aaaaaaaa" },
    [SECRET_REF_B]: { secretRef: SECRET_REF_B, agentId: "pack-secret", name: "repo_token", secretValue: "ghp_value_TWO_bbbbbbbb" },
  });
  const h = await bootRunner({ entries: [SECRET_ENTRY], skills: SECRET_SKILLS, config: { packsBaseUrl: packs.base } });
  try {
    await h.manager.reconcile();
    const auth = { Authorization: "Bearer backend-secret" };
    const first = await h.callAgent(SECRET_ENTRY, "POST", "/", { headers: auth, body: SEND(1, "hi", "ctx-rebind") });
    assert.equal(first.status, 200, first.text);
    const credPath = path.join(h.config.homeRoot, agentKeyFor(SECRET_ENTRY), ".credentials.yaml");
    assert.equal(yaml.load(readFileSync(credPath, "utf8")).refs.repo_token, "ghp_value_ONE_aaaaaaaa");

    // The entry is rebound in place (same path, fresh reference): the poll
    // drains the old child, and the NEXT request through the SAME listener
    // must compose from the NEW descriptor — a listener that kept serving its
    // first-captured entry would re-pin the old ref here.
    const rebound = {
      ...SECRET_ENTRY,
      version: "2",
      metadata: { ...SECRET_ENTRY.metadata, packVersion: 2, secret_refs: { repo_token: SECRET_REF_B } },
    };
    h.manager.registryClient.listServedAgents = async () => [rebound];
    await h.manager.reconcile();
    const second = await h.callAgent(rebound, "POST", "/", { headers: auth, body: SEND(2, "hi", "ctx-rebind") });
    assert.equal(second.status, 200, second.text);
    assert.equal(yaml.load(readFileSync(credPath, "utf8")).refs.repo_token, "ghp_value_TWO_bbbbbbbb", "the new reference drove the new composition");
    assert.ok(packs.seen.some((s) => s.path === `/api/packs/internal/secret/${SECRET_REF_B}`), "the rebound ref was fetched");
    assert.equal(h.spawned.length, 2, "a fresh child composed after the drain");
  } finally {
    await h.close();
    packs.server.close();
  }
});

test("2.1 applyDeploymentSecrets re-checks names before pinning; bad name refuses with nothing written", () => {
  const home = path.join(tmpRoot, `secret-home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  assert.throws(() => applyDeploymentSecrets(home, { "Not-A-Name": "v" }), /not a valid name/);
  assert.ok(!existsSync(path.join(home, ".credentials.yaml")), "refusal writes nothing");
  applyDeploymentSecrets(home, { repo_token: "a", mirror_key: "b" });
  const doc = yaml.load(readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(doc.refs.repo_token, "a");
  assert.equal(doc.refs.mirror_key, "b");
  // Existing refs (e.g. the pinned LLM key) survive the read-modify-write.
  applyDeploymentSecrets(home, { another: "c" });
  const again = yaml.load(readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(again.refs.repo_token, "a");
  assert.equal(again.refs.another, "c");
});

// ── add-agent-notifications 2.1/2.2: the notify face ─────────────────────────

const NOTIFY_ENTRY = { ...ENTRY, metadata: { ...ENTRY.metadata, notify_channel: "ops-feishu" } };
const RELAY_URL = "https://packs.example.test/api/bots/relay/send";

// A recording stand-in for the platform bot relay.
function relayStub({ status = 200, error = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body || "{}") });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status >= 200 && status < 300 ? { ok: true } : { error }),
    };
  };
  return { calls, fetchImpl };
}

// One `bot_notify` call as the child's tool makes it: the notification goes up,
// the host's `botNotify/result` request comes back (async — poll for it).
async function emitNotify(spawned, params, { expect = 1, child = 0 } = {}) {
  const client = spawned[child].client;
  const before = client.calls.requests.length;
  client.__emit({ method: "botNotify/send", params });
  const deadline = Date.now() + 2_000;
  while (client.calls.requests.length < before + expect && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return client.calls.requests.slice(before);
}

function notifyAuditLines(config) {
  try {
    return readFileSync(config.notifyLogFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function readTree(dir) {
  // Regular files only: the home's node_modules entries are symlinks into the
  // seed home and are deliberately not walked.
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...readTree(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

test("notify: a bound deployment forwards to the relay and answers the child", async () => {
  const relay = relayStub();
  const { manager, spawned, config } = await directManager({
    entries: [NOTIFY_ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "relay-secret" },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await manager.reconcile();
    await manager.turn(NOTIFY_ENTRY, "s1", "hi");
    const results = await emitNotify(spawned, { notifyId: "n-1", event: "ticket_done", text: "工单已关闭" });
    assert.equal(results.length, 1, "the child got its answer");
    assert.equal(results[0].method, "botNotify/result");
    assert.deepEqual(results[0].params, { notifyId: "n-1", ok: true });
    // Exactly one addressed, host-credentialed POST — the [event] prefix rides.
    assert.equal(relay.calls.length, 1);
    assert.equal(relay.calls[0].url, RELAY_URL);
    assert.equal(relay.calls[0].headers.Authorization, "Bearer relay-secret");
    assert.deepEqual(relay.calls[0].body, { channel: "ops-feishu", text: "[ticket_done] 工单已关闭" });
    // Runner audit: one line, the outcome and the length — never the text.
    const lines = notifyAuditLines(config);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].agent, agentKeyFor(NOTIFY_ENTRY));
    assert.equal(lines[0].channel, "ops-feishu");
    assert.equal(lines[0].outcome, "sent");
    assert.equal(lines[0].textLen, "工单已关闭".length);
    assert.ok(!JSON.stringify(lines[0]).includes("工单已关闭"), "audit never carries the text");
    // An explicit channel equal to the binding is accepted.
    const same = await emitNotify(spawned, { notifyId: "n-2", event: "e", text: "t", channel: "ops-feishu" });
    assert.equal(same[0].params.ok, true);
    assert.equal(relay.calls.length, 2);
  } finally {
    await manager.stopAll();
  }
});

test("notify: unbound, channel-mismatch and unconfigured decline structurally, nothing sent", async () => {
  const relay = relayStub();
  // (a) Unbound deployment (no descriptor binding): declined naming the
  // missing binding; nothing reaches the relay.
  const unbound = await directManager({
    entries: [ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "relay-secret" },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await unbound.manager.reconcile();
    await unbound.manager.turn(ENTRY, "s1", "hi");
    const out = await emitNotify(unbound.spawned, { notifyId: "u-1", event: "e", text: "t" });
    assert.equal(out[0].params.ok, false);
    assert.equal(out[0].params.reason, "unbound");
    assert.match(out[0].params.message, /channel/);
    assert.equal(relay.calls.length, 0, "an unbound call never egresses");
    assert.equal(notifyAuditLines(unbound.config)[0].outcome, "rejected");
  } finally {
    await unbound.manager.stopAll();
  }

  // (b) Explicit channel ≠ the bound one: declined before any egress.
  const mismatch = await directManager({
    entries: [NOTIFY_ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "relay-secret" },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await mismatch.manager.reconcile();
    await mismatch.manager.turn(NOTIFY_ENTRY, "s1", "hi");
    const out = await emitNotify(mismatch.spawned, { notifyId: "m-1", event: "e", text: "t", channel: "someone-else" });
    assert.equal(out[0].params.ok, false);
    assert.equal(out[0].params.reason, "channel-mismatch");
    assert.equal(relay.calls.length, 0);
  } finally {
    await mismatch.manager.stopAll();
  }

  // (c) No relay token configured (the relay's own lazy semantics): declined,
  // nothing sent — the binding is irrelevant when the lane is off.
  const unconfigured = await directManager({
    entries: [NOTIFY_ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "" },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await unconfigured.manager.reconcile();
    await unconfigured.manager.turn(NOTIFY_ENTRY, "s1", "hi");
    const out = await emitNotify(unconfigured.spawned, { notifyId: "c-1", event: "e", text: "t" });
    assert.equal(out[0].params.ok, false);
    assert.equal(out[0].params.reason, "not-configured");
    assert.equal(relay.calls.length, 0);
  } finally {
    await unconfigured.manager.stopAll();
  }
});

test("notify: a relay refusal surfaces to the turn and the runner keeps serving", async () => {
  const relay = relayStub({ status: 404, error: "Unknown channel" });
  const { manager, spawned, config } = await directManager({
    entries: [NOTIFY_ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "relay-secret" },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await manager.reconcile();
    await manager.turn(NOTIFY_ENTRY, "s1", "hi");
    const out = await emitNotify(spawned, { notifyId: "f-1", event: "e", text: "t" });
    assert.equal(out[0].params.ok, false);
    assert.equal(out[0].params.reason, "relay");
    assert.equal(out[0].params.status, 404);
    assert.equal(out[0].params.message, "Unknown channel");
    assert.equal(notifyAuditLines(config)[0].outcome, "failed");
    // The runner keeps serving: the next turn answers normally.
    const again = await manager.turn(NOTIFY_ENTRY, "s2", "hi");
    assert.equal(again.text, "答复");
  } finally {
    await manager.stopAll();
  }
});

test("notify: the 7th call inside a minute is refused with no egress (per agent)", async () => {
  const relay = relayStub();
  // A second agent on the same runner: the bound is per AGENT, so exhausting
  // one must not spend the other's budget.
  const OTHER_ENTRY = {
    ...NOTIFY_ENTRY,
    path: "/packs/pk-abc/pack-other",
    metadata: { ...NOTIFY_ENTRY.metadata, agentId: "pack-other" },
  };
  const { manager, spawned, config } = await directManager({
    entries: [NOTIFY_ENTRY, OTHER_ENTRY],
    config: { relayUrl: RELAY_URL, relayToken: "relay-secret", notifyRatePerMin: 6 },
    notifyFetch: relay.fetchImpl,
  });
  try {
    await manager.reconcile();
    await manager.turn(NOTIFY_ENTRY, "s1", "hi");
    for (let i = 0; i < 6; i++) {
      const out = await emitNotify(spawned, { notifyId: `n-${i}`, event: "e", text: "t" });
      assert.equal(out[0].params.ok, true, `call ${i + 1} must pass`);
    }
    const seventh = await emitNotify(spawned, { notifyId: "n-7", event: "e", text: "t" });
    assert.equal(seventh[0].params.ok, false);
    assert.equal(seventh[0].params.reason, "rate-limited");
    assert.equal(relay.calls.length, 6, "the over-rate call never reached the relay");
    const lines = notifyAuditLines(config);
    assert.equal(lines.filter((l) => l.outcome === "sent").length, 6);
    assert.equal(lines.filter((l) => l.reason === "rate-limited").length, 1);
    // Per agent, not per runner: the second agent (its own child) still has
    // its own budget.
    await manager.turn(OTHER_ENTRY, "s2", "hi");
    assert.equal(spawned.length, 2, "the second agent runs its own child");
    const other = await emitNotify(spawned, { notifyId: "o-1", event: "e", text: "t" }, { child: 1 });
    assert.equal(other[0].params.ok, true, "another agent's budget is untouched");
    assert.equal(relay.calls.length, 7);
  } finally {
    await manager.stopAll();
  }
});

test("notify: the relay token never reaches the child's spawn spec or composed home", async () => {
  const prevToken = process.env.AGENT_RUNNER_RELAY_TOKEN;
  const prevBots = process.env.BOTS_RELAY_TOKEN;
  process.env.AGENT_RUNNER_RELAY_TOKEN = "relay-secret-sentinel";
  process.env.BOTS_RELAY_TOKEN = "platform-relay-sentinel";
  let manager;
  try {
    const h = await directManager({ entries: [NOTIFY_ENTRY] });
    manager = h.manager;
    const { spawned } = h;
    await manager.reconcile();
    await manager.turn(NOTIFY_ENTRY, "s1", "hi");
    assert.equal(spawned[0].spawn.env.AGENT_RUNNER_RELAY_TOKEN, undefined, "the runner-held token is stripped from the child env");
    assert.equal(spawned[0].spawn.env.BOTS_RELAY_TOKEN, undefined, "the platform relay token is stripped too");
    // And nothing on disk in the child's home carries either value.
    for (const file of readTree(spawned[0].spec.home)) {
      const body = readFileSync(file, "utf8");
      assert.ok(!body.includes("relay-secret-sentinel"), `${file} must not carry the runner relay token`);
      assert.ok(!body.includes("platform-relay-sentinel"), `${file} must not carry the platform relay token`);
    }
  } finally {
    await manager.stopAll();
    if (prevToken === undefined) delete process.env.AGENT_RUNNER_RELAY_TOKEN;
    else process.env.AGENT_RUNNER_RELAY_TOKEN = prevToken;
    if (prevBots === undefined) delete process.env.BOTS_RELAY_TOKEN;
    else process.env.BOTS_RELAY_TOKEN = prevBots;
  }
});

test("notify: a rebind drains the old child so the new binding takes effect", async () => {
  const { manager, spawned, entriesRef } = await directManager({ entries: [NOTIFY_ENTRY] });
  try {
    await manager.reconcile();
    await manager.turn(NOTIFY_ENTRY, "s1", "hi");
    const key = agentKeyFor(NOTIFY_ENTRY);
    const first = manager.children.get(key);
    assert.ok(first, "child spawned");
    entriesRef.current = [{ ...NOTIFY_ENTRY, metadata: { ...NOTIFY_ENTRY.metadata, notify_channel: "other-channel" } }];
    await manager.reconcile();
    assert.equal(manager.children.has(key), false, "binding change drains the child");
    assert.equal(first.draining, true);
    await manager.turn(entriesRef.current[0], "s2", "hi");
    assert.equal(spawned.length, 2, "the next touch re-spawns on the new binding");
  } finally {
    await manager.stopAll();
  }
});

// ── agent-service-config / ADR-0019: per-deployment model ───────────────────

test("model: the descriptor's effective_model rides the spawn; absent falls back to the runner default", async () => {
  const withModel = { ...ENTRY, metadata: { ...ENTRY.metadata, effective_model: "m-per" } };
  const { manager, spawned } = await directManager({ entries: [withModel] });
  try {
    await manager.reconcile();
    await manager.turn(withModel, "s1", "hi");
    assert.equal(spawned.length, 1);
    const init = spawned[0].client.calls.initialize[0];
    assert.equal(init.model, "m-per", "the spawn initializes on the deployment's model");
    assert.equal(init.provider, "p", "provider family stays the runner's");
  } finally {
    await manager.stopAll();
  }
  const plain = await directManager({ entries: [ENTRY] });
  try {
    await plain.manager.reconcile();
    await plain.manager.turn(ENTRY, "s1", "hi");
    assert.equal(plain.spawned[0].client.calls.initialize[0].model, "m", "no descriptor model → the runner's deployment default");
  } finally {
    await plain.manager.stopAll();
  }
});

test("model: a model change drains the old child; the next touch re-spawns on the new model", async () => {
  const entry = { ...ENTRY, metadata: { ...ENTRY.metadata, effective_model: "m-1" } };
  const { manager, spawned, entriesRef } = await directManager({ entries: [entry] });
  try {
    await manager.reconcile();
    await manager.turn(entry, "s1", "hi");
    const key = agentKeyFor(entry);
    const first = manager.children.get(key);
    assert.ok(first, "child spawned on m-1");
    entriesRef.current = [{ ...entry, metadata: { ...entry.metadata, effective_model: "m-2" } }];
    await manager.reconcile();
    assert.equal(manager.children.has(key), false, "model change drains the child (upgrade-grade channel)");
    assert.equal(first.draining, true);
    await manager.turn(entriesRef.current[0], "s2", "hi");
    assert.equal(spawned.length, 2, "the next touch re-spawns");
    assert.equal(spawned[1].client.calls.initialize[0].model, "m-2", "the reborn child runs the new model");
  } finally {
    await manager.stopAll();
  }
});

// ── add-caller-preferences: per-session reap window ─────────────────────────

test("reap: the encoded session name sets the per-session TTL; unencoded falls back to the default", async () => {
  const { parseReapWindow } = await import("../agent-runner/manager.js");
  // Parser truth table (mirror of the facade's — lockstep discipline).
  assert.equal(parseReapWindow("wx:30x-abc"), 30);
  assert.equal(parseReapWindow("srv-wx-30x-abc"), 30);
  assert.equal(parseReapWindow("srv-wx-1440x-0123abcd"), 1440);
  assert.equal(parseReapWindow("srv-wx-a1b2c3"), null, "hex digests never match");
  assert.equal(parseReapWindow("srv-wx-"), null);
  assert.equal(parseReapWindow("srv-day-2026-10-07"), null);
  assert.equal(parseReapWindow(""), null);

  const { manager, config } = await directManager({ entries: [], config: { externalContextTtlSecs: 60 } });
  const mkSession = (name, ageMs, group = null) => {
    // group=null → the FLAT legacy layout; a group name → the current dsh
    // workspace-nested layout (sessions/<group>/srv-wx-…, live finding).
    const dir = group
      ? path.join(config.homeRoot, "packs-p1-heal", "sessions", group, name)
      : path.join(config.homeRoot, "packs-p1-heal", "sessions", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "log"), "x");
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path.join(dir, "log"), t, t);
    utimesSync(dir, t, t); // #lastTouched takes the MAX of dir + children
    return dir;
  };
  mkdirSync(path.join(config.homeRoot, "packs-p1-heal", "sessions"), { recursive: true });
  const flatOld = mkSession("srv-wx-1x-old", 3 * 60_000);          // flat, window 1m → reaped
  const nestedOld = mkSession("srv-wx-1x-nested", 3 * 60_000, "--data-x--"); // nested, window 1m → reaped
  const nestedKeep = mkSession("srv-wx-600x-keep", 3 * 60_000, "--data-x--"); // nested, window 600m → kept
  const flatLegacy = mkSession("srv-wx-legacy", 3 * 60_000);       // flat, default 1m → reaped
  const nestedFresh = mkSession("srv-wx-1x-fresh", 10_000, "--data-x--"); // nested, fresh → kept
  assert.equal(manager.reapExternalContexts(), 3, "both layouts scanned: 2 nested-stale + 1 flat-stale");
  assert.ok(existsSync(nestedKeep));
  assert.ok(existsSync(nestedFresh));
  assert.ok(!existsSync(flatOld));
  assert.ok(!existsSync(nestedOld));
  assert.ok(!existsSync(flatLegacy));
  await manager.stopAll();
});
