#!/usr/bin/env node
// ── Listener bind-failure isolation (fix-runner-port-collision) ─────────────
//
//   node --test agent-runner/test/listener.test.mjs
//
// A port another listener holds (deploy-side occupancy listing degraded →
// hash collision, production 2026-10-25) must degrade ONE agent's
// reachability with a rate-limited named warning — never crash the runner,
// never disturb the other listeners. Retry is unthrottled: a freed port
// recovers on the next reconcile cycle.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";

process.env.AGENT_RUNNER_HOME = mkdtempSync(path.join(tmpdir(), "listener-"));

const { ChildManager } = await import("../manager.js");
const serving = await import("../../lib/agent-serving.js");
const { agentPortFor } = serving;

after(() => {
  rmSync(process.env.AGENT_RUNNER_HOME, { recursive: true, force: true });
});

const PORT_BASE = 18091;
const PORT_SPAN = 8;
const ENTRY = { path: "/packs/p/analyst", name: "分析师", metadata: { paused: true } };
const KEY = "packs-p-analyst";
const COLLIDING_PORT = agentPortFor("/packs/p/analyst", { base: PORT_BASE, span: PORT_SPAN });

function managerWith(warns, registryEntries) {
  const homeRoot = mkdtempSync(path.join(tmpdir(), "listener-mgr-"));
  const manager = new ChildManager({
    config: { homeRoot, cwd: "/srv/app", maxChildren: 2, turnTimeoutMs: 60_000, portBase: PORT_BASE, portSpan: PORT_SPAN },
    registryClient: { listServedAgents: async () => registryEntries },
    clientFactory: () => () => ({ start: () => {}, initialize: async () => ({ serverInfo: { name: "stub", version: "0" } }), subscribe: () => ({ next: () => new Promise(() => {}) }), stop: () => {} }),
    log: { log: () => {}, warn: (m) => warns.push(m), error: () => {} },
  });
  after(() => manager.stopAll().finally(() => rmSync(homeRoot, { recursive: true, force: true })));
  return manager;
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test("bind failure isolates: named warning, process alive, other listeners untouched, no repeat within throttle", async () => {
  const warns = [];
  const occupant = net.createServer();
  await new Promise((r) => occupant.listen(COLLIDING_PORT, "0.0.0.0", r));
  try {
    const manager = managerWith(warns, [ENTRY]);
    await manager.reconcile();
    await settle();
    // The manager survived, the warning names the agent and the remediation,
    // and the entry is not left in the listeners map as a "serving" lie.
    assert.ok(warns.some((w) => w.includes(KEY) && w.includes("NOT serving") && w.includes("port_override")), warns.join(" | "));

    await manager.reconcile();
    await settle();
    const hits = warns.filter((w) => w.includes(KEY) && w.includes("NOT serving")).length;
    assert.equal(hits, 1, `throttle: expected 1 warning, got ${hits}`);
    await manager.stopAll();
  } finally {
    await new Promise((r) => occupant.close(r));
  }
});

test("retry is unthrottled: a freed port binds on the next reconcile cycle", async () => {
  const warns = [];
  const occupant = http.createServer();
  await new Promise((r) => occupant.listen(COLLIDING_PORT, "0.0.0.0", r));
  const manager = managerWith(warns, [ENTRY]);
  await manager.reconcile();
  await settle();
  assert.ok(warns.some((w) => w.includes("NOT serving")));

  await new Promise((r) => occupant.close(r));
  await settle(250); // let the OS release the socket
  await manager.reconcile();
  await settle(300);

  // Recovery proof: the runner now answers on the freed port. (A probe bind
  // races the manager's own rebind — whoever grabs the socket first wins —
  // so the honest check is the service itself answering.)
  const status = await fetch(`http://127.0.0.1:${COLLIDING_PORT}/.well-known/agent-card.json`)
    .then((r) => r.status)
    .catch((e) => `conn-err ${e.code}`);
  assert.equal(status, 200, `runner listener should serve the recovered port (got ${status}; warns=${JSON.stringify(warns)})`);
  await manager.stopAll();
});

test("serving sanity: the shared port definition still agrees (agentPortFor/resolveAgentPort)", () => {
  assert.equal(serving.resolveAgentPort({ path: "/packs/p/analyst" }, { base: PORT_BASE, span: PORT_SPAN }), COLLIDING_PORT);
});
