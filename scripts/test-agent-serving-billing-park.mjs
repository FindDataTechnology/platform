// Billing-failure parking (openspec: add-billing-failure-parking).
//
// Every spec scenario in one file, against the REAL manager/compose pipeline
// (fake dsh client, real local billing-gate HTTP server):
//   park-after-first-failure + single meter line, -32012 fast-fail (send +
//   stream shapes), key-invalid vs insufficient-balance, recharge auto-resume
//   (transport/5xx do NOT unpark), probe-200 flake never parks, key re-pin
//   clears the park via the real respawn path, pause precedence both ways,
//   fresh-manager restart bound, unprobeable provider keeps legacy behavior,
//   health annotation, scheduler/rollover skip seams (the storm shape),
//   kill-switch, config env parsing.
//
//   node --test scripts/test-agent-serving-billing-park.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { after, test } from "node:test";

import { ChildManager } from "../agent-runner/manager.js";
import { Rollover } from "../agent-runner/rollover.js";
import { RhythmScheduler } from "../agent-runner/scheduler.js";
import { agentKeyFor } from "../agent-runner/compose.js";

// The routing store (LLM_PROVIDERS_STORE) is read lazily by the manager's
// route resolver, so pointing it at a temp file here (after imports, before
// any spawn) is enough — llm-providers.js re-reads the file on every lookup.
const STORE_DIR = mkdtempSync(path.join(tmpdir(), "billing-park-store-"));
const STORE_FILE = path.join(STORE_DIR, "llm-providers.json");
process.env.LLM_PROVIDERS_STORE = STORE_FILE;

const ENTRY = {
  path: "/packs/pk-bill/park-agent",
  name: "Park Tester",
  description: "d",
  version: "1",
  metadata: {
    protocol: "a2a",
    packId: "pk-bill",
    packVersion: 1,
    agentId: "park-agent",
    agentName: "Park Tester",
    persona: "你是测试 agent。",
    skills: [],
    mcpServers: [],
  },
};
const KEY = agentKeyFor(ENTRY);

// ── Fakes ────────────────────────────────────────────────────────────────────

// One local server, two faces: the billing gate (GET /v1/models — the
// zero-spend probe target) and the pack gateway's internal key route. The
// manager's probe uses REAL global fetch against it, so status mapping,
// headers, and JSON parsing all run the production path.
function fakeGateAndPacks() {
  const hits = [];
  const state = { probeStatus: 200, probeBody: { data: [] }, llmKey: "sk-deployer-1" };
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url, auth: req.headers.authorization ?? null });
    if (req.url.startsWith("/api/packs/internal/llm-key/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keyValue: state.llmKey }));
      return;
    }
    if (req.url.startsWith("/v1/models")) {
      if (state.probeStatus === "destroy") { res.destroy(); return; }
      res.writeHead(state.probeStatus, { "content-type": "application/json" });
      res.end(typeof state.probeBody === "string" ? state.probeBody : JSON.stringify(state.probeBody));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      hits, state,
      url: `http://127.0.0.1:${server.address().port}`,
      probeHits: () => hits.filter((h) => h.path.startsWith("/v1/models")),
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// A dsh-shaped client whose prompt() fails the first `state.fail` turns with
// the finish-error chunk (the -32003 shape the dsh adapter settles on) and
// answers the rest with text + idle.
function scriptableClient(state) {
  const calls = { prompt: [], started: 0 };
  const client = {
    calls, state,
    start() { calls.started += 1; },
    async initialize() { return { ok: true }; },
    async request() { return { accepted: true }; },
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
      if (state.fail > 0) {
        state.fail -= 1;
        setTimeout(() => {
          client.__emit({
            method: "platform/stream",
            params: { sessionId, frame: { chunk: { type: "finish", reason: { kind: "error", failure: { message: "403 status code (no body)" } } } } },
          });
        }, 0);
        return "m-err";
      }
      setTimeout(() => {
        client.__emit({
          method: "session.event",
          params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: state.reply ?? "正常回复" }] } } } },
        });
        client.__emit({ method: "session.status", params: { sessionId, status: "idle" } });
      }, 0);
      return "m-ok";
    },
    async stop() {},
  };
  return client;
}

const SILENT = { log() {}, warn() {}, error() {} };

let portCounter = 24_000;
function nextPortBase() {
  portCounter += 41;
  return portCounter;
}
async function bootManager({ gate, entry = ENTRY, clientState = { fail: 0, reply: "正常回复" }, packs = false, providerType = "openai-completions", cfg = {} } = {}) {
  // The routing store the manager's probe resolver reads: one provider row
  // whose baseUrl IS the fake gate. Rewritten per boot so every test's gate
  // URL and provider type are current.
  writeFileSync(STORE_FILE, JSON.stringify({
    providers: [{
      id: "billprov", name: "BillProv", baseUrl: `${gate.url}/v1`, apiKey: "sk-runner-fallback",
      type: providerType, models: [], reasoningEfforts: [], createdAt: "", lastTest: null,
    }],
  }));
  const homeRoot = mkdtempSync(path.join(tmpdir(), "billing-park-"));
  const clock = { ms: Date.now() };
  const config = {
    homeRoot,
    registryUrl: "https://mcp.example.test",
    registryToken: "tok",
    provider: "billprov",
    model: "test-model",
    backendToken: "backend-secret",
    maxChildren: 2,
    drainMs: 500,
    turnTimeoutMs: 5_000,
    dshProfile: "platform",
    cwd: tmpdir(),
    portBase: nextPortBase(),
    portSpan: 32,
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
    billingParkEnabled: true,
    billingReprobeSecs: 600,
    ...(packs ? { packsBaseUrl: gate.url } : {}),
    ...cfg,
  };
  const events = [];
  let current = entry;
  const registryClient = {
    listServedAgents: async () => [current],
    fetchSkillContent: async () => "# s",
    mcpUrlFor: (n) => `https://mcp.example.test/${n}/mcp`,
  };
  const manager = new ChildManager({
    config,
    registryClient,
    clientFactory: () => () => scriptableClient(clientState),
    log: SILENT,
    now: () => clock.ms,
    events: (ev) => events.push(ev),
  });
  await manager.reconcile();
  return {
    manager, events, clock, config, homeRoot,
    // The registry's view of the role changes (a redeploy / rebind): the next
    // reconcile runs the identity pass on it.
    setEntry: (e) => { current = e; },
    close: () => manager.stopAll(),
  };
}

async function waitUntil(fn, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

// Drive one doomed turn through the real pipeline: rejects -32003 exactly the
// way a dead billing key makes dsh report it.
async function driveFailingTurn(manager, sessionId = "srv-test-1") {
  const entry = manager.entries.get(KEY);
  await assert.rejects(
    () => manager.turn(entry, sessionId, "hi"),
    (e) => e.code === -32003,
  );
}

const meterLines = (h) =>
  readFileSync(h.config.meterFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── 1.3 config: env parsing, both shapes ─────────────────────────────────────

test("config: billing park defaults on; every falsy spelling disables; reprobe secs parse", async () => {
  const { loadConfig } = await import("../agent-runner/config.js");
  const base = loadConfig({});
  assert.equal(base.billingParkEnabled, true, "default on");
  assert.equal(base.billingReprobeSecs, 600, "default 600 s cadence");
  for (const off of ["0", "false", "off", "no", "OFF", " off "]) {
    assert.equal(loadConfig({ AGENT_RUNNER_BILLING_PARK: off }).billingParkEnabled, false, `off spelling "${off}"`);
  }
  for (const on of ["1", "true", "on", "yes", ""]) {
    assert.equal(loadConfig({ AGENT_RUNNER_BILLING_PARK: on }).billingParkEnabled, true, `on spelling "${on}"`);
  }
  assert.equal(loadConfig({ AGENT_RUNNER_BILLING_REPROBE_SECS: "120" }).billingReprobeSecs, 120);
  assert.equal(loadConfig({ AGENT_RUNNER_BILLING_REPROBE_SECS: "garbage" }).billingReprobeSecs, 600);
});

// ── 2.2 + spec: exhausted key parks after ONE failed turn ────────────────────

test("an exhausted key parks the role after one failed turn: one probe, one meter line, no second spawn", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, clientState: { fail: 99, reply: "never" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)), "parked after the first failure");
    const park = h.manager.parkedInfo(KEY);
    assert.equal(park.reason, "insufficient-balance");
    assert.equal(park.detail, "INSUFFICIENT_BALANCE");
    assert.ok(Number.isFinite(park.since), "park time recorded");

    // The probe hit the gate once, with the pinned runner-level fallback key.
    const probes = gate.probeHits();
    assert.equal(probes.length, 1, "exactly one zero-spend probe");
    assert.equal(probes[0].auth, "Bearer sk-runner-fallback");

    // Fleet event rides the existing bus with the full park tuple.
    const ev = h.events.find((e) => e.kind === "billing_parked");
    assert.ok(ev, "billing_parked emitted");
    assert.equal(ev.payload.reason, "insufficient-balance");
    assert.equal(ev.payload.detail, "INSUFFICIENT_BALANCE");
    assert.equal(ev.payload.since, park.since);

    // The failed turn is metered EXACTLY once; subsequent parked refusals
    // add nothing (they throw before the metering try block, like pause).
    await assert.rejects(() => h.manager.turn(h.manager.entries.get(KEY), "srv-test-2", "again"), (e) => e.code === -32012);
    const lines = meterLines(h);
    assert.equal(lines.length, 1, "one meter line total");
    assert.equal(lines[0].ok, false);
    assert.match(lines[0].error, /403 status code/);

    // No second child spawn for the parked turn.
    assert.equal(h.manager.children.size, 1);
    const child = h.manager.children.get(KEY);
    assert.equal(child.adapter.client.calls.prompt.length, 1, "no further prompt reached the runtime");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 1.2 + spec: inbound fast-fail, send + stream shapes ──────────────────────

test("an inbound message to a parked role fails fast with -32012 and a readable reason (send + stream)", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "ok" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    const probesBefore = gate.probeHits().length;
    const promptsBefore = h.manager.children.get(KEY).adapter.client.calls.prompt.length;

    const auth = { "Content-Type": "application/json", Authorization: "Bearer backend-secret" };
    const port = h.manager.health().agents[0].port;
    const send = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], context_id: "c1" } } }),
    });
    const doc = await send.json();
    assert.equal(doc.error.code, -32012, "send rejects with the parked code");
    assert.match(doc.error.message, /agent parked: insufficient-balance \(INSUFFICIENT_BALANCE\) since \d{4}-\d{2}-\d{2}T/, "message names reason and park time");

    const stream = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/stream", params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], context_id: "c2" } } }),
    });
    const text = await stream.text();
    assert.match(text, /event: error/);
    assert.match(text, /"code":-32012/);
    assert.match(text, /insufficient-balance/);

    // No LLM request, no cold-start, no fresh probe for either refusal.
    assert.equal(h.manager.children.get(KEY).adapter.client.calls.prompt.length, promptsBefore, "no prompt issued");
    assert.equal(gate.probeHits().length, probesBefore, "no probe issued");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 2.1 + spec: invalid key parks with its own reason ────────────────────────

test("an invalid key parks with reason key-invalid, distinct from insufficient-balance", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 401;
  gate.state.probeBody = { code: "INVALID_API_KEY", message: "invalid key" };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "ok" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    const park = h.manager.parkedInfo(KEY);
    assert.equal(park.reason, "key-invalid");
    assert.equal(park.detail, "INVALID_API_KEY");
    assert.notEqual(park.reason, "insufficient-balance", "re-keying is distinguishable from recharging");
    // 401 + INVALID_API_KEY also parks when the gate answers 403 with it.
    assert.equal(gate.probeHits().length, 1);
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 3.2 + spec: recharge resumes automatically; 5xx/transport never unpark ───

test("recharging resumes the role on the next re-probe; a 500 or a transport failure keeps it parked", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "复业成功" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));

    // Non-2xx non-rejection statuses are NOT passes — no unpark on a 500.
    h.clock.ms += 61_000; // past the 60 s per-key probe floor
    gate.state.probeStatus = 500;
    await h.manager.reprobeParked();
    assert.ok(h.manager.isParked(KEY), "a 500 from the gate does not unpark");

    // A transport failure is not a pass either.
    h.clock.ms += 61_000;
    gate.state.probeStatus = "destroy";
    await h.manager.reprobeParked();
    assert.ok(h.manager.isParked(KEY), "a transport failure does not unpark");

    // The gate accepting the key again (200) un-parks, emits the resume event
    // with the ORIGINAL reason, and the next turn runs normally.
    h.clock.ms += 61_000;
    gate.state.probeStatus = 200;
    gate.state.probeBody = { data: [] };
    await h.manager.reprobeParked();
    assert.ok(!h.manager.isParked(KEY), "probe pass unparks");
    const ev = h.events.find((e) => e.kind === "billing_unparked");
    assert.ok(ev, "billing_unparked emitted");
    assert.equal(ev.payload.reason, "insufficient-balance", "resume event carries the original reason");
    const out = await h.manager.turn(h.manager.entries.get(KEY), "srv-test-1", "again");
    assert.equal(out.text, "复业成功", "the next turn after unpark succeeds");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 2.1 + spec: an upstream flake (probe 200) never parks ────────────────────

test("an upstream flake does not park: probe passes, failed turn metered, next turn runs", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 200;
  gate.state.probeBody = { data: [] };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "flake后正常" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => gate.probeHits().length === 1), "the probe ran");
    await new Promise((r) => setTimeout(r, 80)); // classification settles
    assert.ok(!h.manager.isParked(KEY), "probe 200 ⇒ no park");
    // The failed turn kept its exact pre-change metering; the next turn runs.
    const lines0 = meterLines(h);
    assert.equal(lines0.length, 1);
    assert.equal(lines0[0].ok, false);
    const out = await h.manager.turn(h.manager.entries.get(KEY), "srv-test-1", "again");
    assert.equal(out.text, "flake后正常");
    const lines1 = meterLines(h);
    assert.equal(lines1.length, 2);
    assert.equal(lines1[1].ok, true);
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 1.1 + spec: a key re-pin clears the park (real re-materialization) ──────

test("a key re-pin clears the park: identity change re-materializes, the new ref re-pins, the turn proceeds", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const refEntry = {
    ...ENTRY,
    metadata: { ...ENTRY.metadata, billing_key_ref: "ref-1" },
  };
  const h = await bootManager({ gate, entry: refEntry, packs: true, clientState: { fail: 1, reply: "新key工作正常" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    assert.equal(gate.probeHits().at(-1).auth, "Bearer sk-deployer-1", "first pin probed the first deployer key");

    // Re-pin: the deployer rebinds to ref-2, whose key the gate ACCEPTS. The
    // next reconcile sees the billing-ref identity change, re-materializes
    // (drain), and the identity pass clears the park — the turn then spawns
    // the new composition, re-pins from ref-2, and proceeds.
    gate.state.llmKey = "sk-deployer-2";
    gate.state.probeStatus = 200;
    gate.state.probeBody = { data: [] };
    h.setEntry({ ...refEntry, metadata: { ...refEntry.metadata, billing_key_ref: "ref-2" } });
    await h.manager.reconcile();
    assert.ok(!h.manager.isParked(KEY), "the identity change cleared the park");
    const out = await h.manager.turn(h.manager.entries.get(KEY), "srv-test-1", "again");
    assert.equal(out.text, "新key工作正常", "the first turn on the new key proceeds — no -32012");

    // The pin record was refreshed from the NEW ref: force one more -32003 —
    // the probe that fires must carry the new key's bearer, and a rejected
    // new key parks again on that single failure.
    h.manager.children.get(KEY).adapter.client.state.fail = 1;
    gate.state.probeStatus = 403;
    gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "again" };
    h.clock.ms += 61_000;
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)), "a rejected new key parks again — the record refresh is honest");
    assert.equal(gate.probeHits().at(-1).auth, "Bearer sk-deployer-2", "the pin record was refreshed from the new ref");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 1.2 + spec: deployer pause and automatic park are independent ────────────

test("pause wins while paused, and after resume the park still gates turns", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "ok" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));

    h.manager.pausedKeys.add(KEY); // registry-marked deployer pause
    await assert.rejects(() => h.manager.turn(h.manager.entries.get(KEY), "s", "x"), (e) => e.code === -32010);

    h.manager.pausedKeys.delete(KEY); // deployer resumes
    await assert.rejects(() => h.manager.turn(h.manager.entries.get(KEY), "s", "x"), (e) => e.code === -32012, "park still gates after resume");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── spec: a runner restart bounds the regression to one turn ─────────────────

test("a fresh manager (restart shape) re-parks after exactly one failed turn", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const first = await bootManager({ gate, clientState: { fail: 1, reply: "ok" } });
  const second = await bootManager({ gate, clientState: { fail: 99, reply: "never" } });
  try {
    await driveFailingTurn(first.manager);
    assert.ok(await waitUntil(() => first.manager.isParked(KEY)));
    // The park is process-local: the restarted manager starts clean…
    assert.ok(!second.manager.isParked(KEY), "park state does not survive a restart");
    // …and re-derives it from one fresh failed turn.
    await driveFailingTurn(second.manager, "srv-restart-1");
    assert.ok(await waitUntil(() => second.manager.isParked(KEY)), "re-parked after one failed turn");
  } finally {
    await first.close();
    await second.close();
    await gate.close();
  }
});

// ── 2.1 + spec: an unprobeable provider keeps today's behavior ───────────────

test("an unprobeable provider never probes and never parks — legacy behavior untouched", async () => {
  const gate = await fakeGateAndPacks();
  const h = await bootManager({ gate, providerType: "anthropic", clientState: { fail: 99, reply: "never" } });
  try {
    await driveFailingTurn(h.manager);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!h.manager.isParked(KEY), "never parked");
    assert.equal(gate.probeHits().length, 0, "never probed — the type gate fires first");
    // The failure path itself is unchanged: the next turn attempts the LLM again.
    await driveFailingTurn(h.manager, "srv-test-2");
    const prompts = h.manager.children.get(KEY).adapter.client.calls.prompt.length;
    assert.equal(prompts, 2, "legacy retry-on-next-touch behavior");
    const lines = meterLines(h);
    assert.equal(lines.length, 2, "every failed turn still meters");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 3.3 + spec: health reports the park alongside the lifecycle state ────────

test("health annotates a parked role with reason and time, without touching the five states", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, clientState: { fail: 1, reply: "ok" } });
  try {
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    const row = h.manager.health().agents.find((a) => a.key === KEY);
    assert.ok(["paused", "draining", "starting", "serving", "resident", "warm"].includes(row.state), "lifecycle state stays in the five-state vocabulary");
    assert.deepEqual(row.parked, { reason: "insufficient-balance", since: h.manager.parkedInfo(KEY).since }, "park annotation alongside");

    // And it disappears on unpark.
    gate.state.probeStatus = 200;
    gate.state.probeBody = { data: [] };
    h.clock.ms += 61_000;
    await h.manager.reprobeParked();
    const after = h.manager.health().agents.find((a) => a.key === KEY);
    assert.equal(after.parked, undefined, "no annotation once resumed");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── 3.1: skip seams — the storm shape ────────────────────────────────────────

test("a parked role's day-rollover digest is not retried by the next check (the 2874-retry storm)", async () => {
  const gate = await fakeGateAndPacks();
  const h = await bootManager({ gate, clientState: { fail: 0, reply: "ok" } });
  try {
    // A resident child with a stale day marker: exactly the rollover's retry
    // shape. First a healthy turn so a child exists.
    await h.manager.turn(h.manager.entries.get(KEY), "srv-day-20200101", "day one");
    writeFileSync(path.join(h.homeRoot, KEY, "last-roll.json"), JSON.stringify({ day: "2020-01-01" }));
    const rollover = new Rollover({ manager: h.manager, config: h.config, log: SILENT, now: () => Date.now() });

    // Park it, then run the 60 s check twice — the digest is skipped both
    // times (no prompt, marker untouched).
    gate.state.probeStatus = 403;
    gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
    h.manager.children.get(KEY).adapter.client.state.fail = 1;
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    const promptsBefore = h.manager.children.get(KEY).adapter.client.calls.prompt.length;
    await rollover.check();
    await rollover.check();
    assert.equal(h.manager.children.get(KEY).adapter.client.calls.prompt.length, promptsBefore, "no digest turn while parked");
    assert.equal(JSON.parse(readFileSync(path.join(h.homeRoot, KEY, "last-roll.json"), "utf8")).day, "2020-01-01", "marker stays stale-silent, not retried");

    // After unpark the next check rolls the day normally.
    gate.state.probeStatus = 200;
    gate.state.probeBody = { data: [] };
    h.clock.ms += 61_000;
    await h.manager.reprobeParked();
    await rollover.check();
    assert.equal(h.manager.children.get(KEY).adapter.client.calls.prompt.length, promptsBefore + 1, "digest runs after unpark");
    assert.notEqual(JSON.parse(readFileSync(path.join(h.homeRoot, KEY, "last-roll.json"), "utf8")).day, "2020-01-01", "marker advanced");
  } finally {
    await h.close();
    await gate.close();
  }
});

test("a parked role's rhythm self-turns do not fire, even when due; they resume after unpark", async () => {
  const gate = await fakeGateAndPacks();
  const rhythmEntry = { ...ENTRY, metadata: { ...ENTRY.metadata, effective_rhythm: [{ every: "5m", do: "tick" }] } };
  const h = await bootManager({ gate, entry: rhythmEntry, clientState: { fail: 1, reply: "节奏回复" } });
  try {
    let nowMs = Date.now();
    const scheduler = new RhythmScheduler({ manager: h.manager, config: h.config, log: SILENT, now: () => nowMs });
    await scheduler.tick(); // anchors set; due is 5 m out, no child spawned yet

    // Park the role (the failing turn spawns the child), advance PAST the due
    // time: the tick must not fire.
    gate.state.probeStatus = 403;
    gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
    await driveFailingTurn(h.manager);
    assert.ok(await waitUntil(() => h.manager.isParked(KEY)));
    const promptsBefore = h.manager.children.get(KEY).adapter.client.calls.prompt.length;
    nowMs += 6 * 60_000;
    await scheduler.tick();
    assert.equal(h.manager.children.get(KEY).adapter.client.calls.prompt.length, promptsBefore, "no self-turn while parked, even past due");

    // Unpark: the next tick re-anchors, the one after fires.
    gate.state.probeStatus = 200;
    gate.state.probeBody = { data: [] };
    h.clock.ms += 61_000;
    await h.manager.reprobeParked();
    nowMs += 60_000;
    await scheduler.tick(); // re-anchor from now
    nowMs += 6 * 60_000;
    await scheduler.tick(); // due — fires
    assert.equal(h.manager.children.get(KEY).adapter.client.calls.prompt.length, promptsBefore + 1, "self-turn resumed after unpark");
    const selfEvents = h.events.filter((e) => e.kind === "turn_started" && e.payload.turn_kind === "self");
    assert.equal(selfEvents.length, 1, "exactly one self-turn fired");
  } finally {
    await h.close();
    await gate.close();
  }
});

// ── D5: the kill-switch disables probing and parking entirely ────────────────

test("AGENT_RUNNER_BILLING_PARK=off: no probe, no park, reprobe timer inert — legacy behavior", async () => {
  const gate = await fakeGateAndPacks();
  gate.state.probeStatus = 403;
  gate.state.probeBody = { code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
  const h = await bootManager({ gate, cfg: { billingParkEnabled: false }, clientState: { fail: 99, reply: "never" } });
  try {
    await driveFailingTurn(h.manager);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(!h.manager.isParked(KEY), "no park under the kill-switch");
    assert.equal(gate.probeHits().length, 0, "no probe under the kill-switch");
    await h.manager.reprobeParked(); // inert by construction
    assert.equal(gate.probeHits().length, 0);
    // The turn pipeline itself is untouched.
    await driveFailingTurn(h.manager, "srv-test-2");
    assert.equal(meterLines(h).length, 2);
  } finally {
    await h.close();
    await gate.close();
  }
});

// Shared cleanup of the temp store dir (best-effort; mkdtemp dirs live in tmpdir).
after(() => {
  try { rmSync(STORE_DIR, { recursive: true, force: true }); } catch { /* tmpdir housekeeping */ }
});
