#!/usr/bin/env node
// ── agent-runner entrypoint (add-a2a-agent-serving 4.1) ────────────────────
//
// Multi-tenant runner for deployed Agent Services (ADR-0004). Boots inert —
// polls the registry, hosts nothing — then serves A2A for whatever deploy
// actions registered. One dsh child per role, private DSH_HOME, runner-level
// model. Runbook: see the agent-runner design (docs/adr/0004).

import http from "node:http";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createRegistryClient } from "./registry.js";
import { ChildManager } from "./manager.js";
import { Rollover } from "./rollover.js";
import { RhythmScheduler } from "./scheduler.js";
import { createOpsApp } from "./a2a.js";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { matrixGate } from "../lib/dsh-matrix-verify.js";

const config = loadConfig();

if (!config.registryUrl) {
  console.error("[agent-runner] AGENT_SERVING_REGISTRY_URL (or REGISTRY_URL) is required — nothing to poll");
  process.exit(1);
}

// dsh install-matrix boot gate (add-dsh-matrix-lock, ADR-0007) — same
// contract as the platform server's: tree deviating from the frozen lock
// refuses to start with a package-level diff, DSH_MATRIX_OVERRIDE=1 forces
// with the report logged, no install root (local dev) skips.
{
  const matrixLock = process.env.DSH_MATRIX_LOCK
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dsh-matrix", "package-lock.json");
  const matrixRoot = process.env.DSH_MATRIX_INSTALL_ROOT || "/opt/dsh";
  const gate = matrixGate({ lockPath: matrixLock, installRoot: matrixRoot });
  if (gate.action === "fail") {
    console.error(gate.diff.report);
    console.error(`[agent-runner] refusing to start — dsh tree deviates from the frozen matrix (DSH_MATRIX_OVERRIDE=1 to force)`);
    process.exit(1);
  } else if (gate.action === "override") {
    console.warn(`[agent-runner] DSH_MATRIX_OVERRIDE set — booting despite dsh tree deviations:`);
    console.warn(gate.diff.report);
  } else if (gate.action === "skip") {
    console.log(`[agent-runner] no install root at ${matrixRoot} — skipping dsh tree verification`);
  } else {
    console.log(`[agent-runner] dsh install tree matches frozen matrix (${matrixRoot})`);
  }
}

mkdirSync(config.homeRoot, { recursive: true });

// The real child factory: one HarnessClient per spawn spec, with the private
// home as DSH_HOME. env inherits the runner's own environment (a dedicated
// service: its LLM keys ARE the child's keys), minus anything the scrub would
// strip for MCP subprocesses — dsh's own subprocess layer does that scrubbing.
const clientFactory = (spec) => ({ args, cwd, env }) => {
  const client = new HarnessClient({
    command: config.dshBin,
    args,
    cwd,
    env: { ...env, DSH_HOME: spec.home },
    // The child's request timeout rides its effective turn budget
    // (add-serving-budgets D3): the manager resolves descriptor-minutes vs
    // the deployment default and passes the ms on the spawn spec.
    requestTimeoutMs: (spec.turnBudgetMs ?? config.turnTimeoutMs) + 30_000,
    shutdownTimeoutMs: 5000,
  });
  // AgentChild calls start() itself — one lifecycle owner.
  return {
    start: () => client.start(),
    initialize: (p) => client.initialize(p),
    subscribe: () => client.subscribe(),
    prompt: (sid, blocks) => client.prompt(sid, blocks),
    request: (m, p) => client.request(m, p),
    // HarnessClient's lifecycle end is close() (the EOF→SIGTERM→SIGKILL
    // ladder); it has no stop(). The old `client.stop?.()` was a silent no-op
    // that orphaned the dsh child on manager.stopAll().
    stop: async () => {
      await client.close?.();
    },
  };
};

// The manager's factory receives the materialized spec so env/home bind per
// child; the inner ({args,cwd,env}) shape matches what AgentChild builds.
const wrappedFactory = (spec) => (specArg) => clientFactory(spec)(specArg);

const manager = new ChildManager({ config, registryClient: createRegistryClient(config), clientFactory: wrappedFactory });

// Fleet observability (add-fleet-event-backbone 3.1): direct-post reporter +
// state sampler, fully inert without AGENT_RUNNER_FLEET_URL.
let fleetReporter = null;
let fleetSampler = null;
if (config.fleetUrl) {
  const { createFleetReporter, createFleetSampler } = await import("./fleet.js");
  fleetReporter = createFleetReporter({
    url: config.fleetUrl,
    token: config.fleetToken,
    runnerId: config.fleetRunnerId,
    spoolFile: path.join(config.homeRoot, ".fleet-spool.jsonl"),
    log: (m) => console.warn(`[agent-runner:fleet] ${m}`),
  });
  fleetReporter.start();
  fleetSampler = createFleetSampler({ manager, reporter: fleetReporter, runnerId: config.fleetRunnerId });
  manager.events = (ev) => fleetReporter.emit(ev);
  console.log(`[agent-runner:fleet] reporting to ${config.fleetUrl} as ${config.fleetRunnerId}`);
}
// Residency wiring (add-agent-residency): rollover owns the day boundary,
// the scheduler consumes its pending digest at the day's head.
const rollover = new Rollover({ manager, config });
manager.onSpawnHook = (key, entry) => void rollover.onSpawn(key, entry).catch(() => {});
const scheduler = new RhythmScheduler({ manager, rollover, config });
const app = createOpsApp({ manager });
const server = http.createServer(app);

let stopping = false;
async function poll() {
  try {
    const n = await manager.reconcile();
    console.log(`[agent-runner] poll: ${n} served agent(s), ${manager.children.size} child(ren)`);
  } catch (e) {
    console.warn(`[agent-runner] poll failed (keeping last-good): ${e.message}`);
  }
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`[agent-runner] listening on :${config.port} (home: ${config.homeRoot}, registry: ${config.registryUrl}, model: ${config.provider}/${config.model}, cap: ${config.maxChildren})`);
  poll();
  const pollTimer = setInterval(poll, config.pollSecs * 1000);
  pollTimer.unref?.();
  // Residency cadences (add-agent-residency): warm-zone budget enforcement,
  // rhythm self-turns, and the day rollover — no idle reap exists anymore.
  const budgetTimer = setInterval(() => manager.enforceBudget(), config.sampleSecs * 1000);
  budgetTimer.unref?.();
  const rhythmTimer = setInterval(() => void scheduler.tick(), config.rhythmTickMs);
  rhythmTimer.unref?.();
  const rolloverTimer = setInterval(() => void rollover.check(), 60_000);
  rolloverTimer.unref?.();
  // External-context reap (add-wanxing-serving-api D10): idle wx sessions are
  // short-lived by contract; internal and rhythm sessions are untouched.
  const reapTimer = setInterval(() => manager.reapExternalContexts(), 60_000);
  reapTimer.unref?.();
  // Data-workspace quota guard (facet-mcp-foundation-v1 3.1): slow cadence —
  // a du over GB-scale dirs is IO, and a guardrail that only speaks needs no
  // urgency.
  const quotaTimer = setInterval(() => manager.checkWorkspaceQuotas(), 60_000);
  quotaTimer.unref?.();
  if (fleetSampler) {
    const fleetTimer = setInterval(() => fleetSampler.sample(), config.fleetSampleSecs * 1000);
    fleetTimer.unref?.();
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[agent-runner] ${sig}: draining children`);
    server.close();
    await manager.stopAll();
    fleetReporter?.stop();
    process.exit(0);
  });
}
