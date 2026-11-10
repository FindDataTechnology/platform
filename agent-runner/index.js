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
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
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
  const client = new HarnessClient(
    {},
    dshClientRuntime({
      command: config.dshBin,
      // dshBinArgs: desktop ships dsh as a Node entry behind the bundled
      // node, so the real argv is [node, <entry>, ...dsh argv]; cloud keeps
      // an empty prefix.
      args: [...(config.dshBinArgs || []), ...args],
      cwd,
      env: { ...env, DSH_HOME: spec.home },
      // The child's request timeout rides its effective turn budget
      // (add-serving-budgets D3): the manager resolves descriptor-minutes vs
      // the deployment default and passes the ms on the spawn spec.
      requestTimeoutMs: (spec.turnBudgetMs ?? config.turnTimeoutMs) + 30_000,
      shutdownTimeoutMs: 5000,
    }),
  );
  // AgentChild calls start() itself — one lifecycle owner.
  return {
    start: () => client.start(),
    initialize: (p) => client.initialize(p),
    subscribe: () => client.subscribe(),
    prompt: (sid, blocks) => client.prompt(sid, blocks),
    request: (m, p) => client.request(m, p),
    // The warm-zone budget samples the child's RSS through this pid
    // (manager.js sampleRssBytes); the SDK keeps the spawned dsh process at
    // `child`. Without this forwarder the budget saw the 96MB planning floor
    // for every live child (measured live 2026-10-11: three real children at
    // 141-200MB counted as 3×96).
    pid: () => client.child?.pid ?? null,
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

const registryClient = createRegistryClient({
    registryUrl: config.registryUrl,
    registryToken: config.registryToken,
    // Sharding (add-runner-fleet-sharding D1): the fleet id hosts only its
    // assigned slice; untagged entries default to this runner when it is the
    // fleet's default (AGENT_RUNNER_DEFAULT_ID, itself by default).
    runnerId: config.fleetRunnerId,
    defaultRunnerId: config.defaultRunnerId,
  });
const manager = new ChildManager({
  config,
  registryClient,
  clientFactory: wrappedFactory,
});

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
  fleetSampler = createFleetSampler({
    manager,
    reporter: fleetReporter,
    runnerId: config.fleetRunnerId,
    // Harness self-report (add-harness-adapter D5): the deploy gate reads this
    // off the observer board to refuse harness-mismatched placements.
    harnessProvider: () => manager.harnessRegistry.names(),
        // Density self-report (unify-wanxing-management-plane): pod co-hosting mode.
        podMode: config.podMode === true,
        // Desktop seat self-report (add-desktop-fleet-runner ③).
        desktopMode: config.desktopMode === true,
  });
  manager.events = (ev) => fleetReporter.emit(ev);
  console.log(`[agent-runner:fleet] reporting to ${config.fleetUrl} as ${config.fleetRunnerId}`);
}
  // Residency wiring (add-agent-residency): rollover owns the day boundary,
  // the scheduler consumes its pending digest at the day's head.
  const rollover = new Rollover({ manager, config });
  manager.onSpawnHook = (key, entry) => void rollover.onSpawn(key, entry).catch(() => {});
  const scheduler = new RhythmScheduler({ manager, rollover, config });

  // Seat mailbox (add-desktop-fleet-runner ④): the desktop's outbound half —
  // poll the facade's per-seat box over the same fleet prefix, run each task
  // locally, settle the result. Desktop seats only: a CLOUD runner's fleet
  // uplink points at the bare observer (no mailbox face there) — polling it
  // would be a 404 every pass.
  if (config.fleetUrl && config.fleetToken && config.desktopMode) {
    const { createMailboxPoller } = await import("./mailbox.js");
    const pollSecs = Number(config.mailboxPollSecs) > 0 ? Number(config.mailboxPollSecs) : 30;
    const mailbox = createMailboxPoller({
      manager,
      registryClient,
      url: config.fleetUrl,
      token: config.fleetToken,
      pollSecs,
      log: (m) => console.log(`[agent-runner:mailbox] ${m}`),
    });
    mailbox.start();
  }

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

server.listen(config.port, config.host, () => {
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
  // Billing-park re-probe (add-billing-failure-parking D4): parked roles only,
  // on the slow cadence — a key the gate accepts again resumes automatically.
  // The kill-switch (AGENT_RUNNER_BILLING_PARK=off) leaves the timer unarmed.
  if (config.billingParkEnabled !== false) {
    const reprobeTimer = setInterval(() => void manager.reprobeParked(), config.billingReprobeSecs * 1000);
    reprobeTimer.unref?.();
  }
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
