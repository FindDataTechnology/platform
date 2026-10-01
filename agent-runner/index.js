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
    requestTimeoutMs: config.turnTimeoutMs + 30_000,
    shutdownTimeoutMs: 5000,
  });
  // AgentChild calls start() itself — one lifecycle owner.
  return {
    start: () => client.start(),
    initialize: (p) => client.initialize(p),
    subscribe: () => client.subscribe(),
    prompt: (sid, blocks) => client.prompt(sid, blocks),
    request: (m, p) => client.request(m, p),
    stop: () => client.stop?.(),
  };
};

// The manager's factory receives the materialized spec so env/home bind per
// child; the inner ({args,cwd,env}) shape matches what AgentChild builds.
const wrappedFactory = (spec) => (specArg) => clientFactory(spec)(specArg);

const manager = new ChildManager({ config, registryClient: createRegistryClient(config), clientFactory: wrappedFactory });
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
  const reapTimer = setInterval(() => manager.reapIdle(), 60_000);
  reapTimer.unref?.();
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[agent-runner] ${sig}: draining children`);
    server.close();
    await manager.stopAll();
    process.exit(0);
  });
}
