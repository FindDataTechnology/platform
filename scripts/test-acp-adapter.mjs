#!/usr/bin/env node
// ── ACP adapter contract at the dsh seam (harden-cell-execution-reliability
//    task 3.4) ────────────────────────────────────────────────────────────────
//
// Spec (harness-adapter, "Core execution modules carry contract tests"):
// `agent-runner/harness/acp.js` — adapter contract parity with the dsh
// adapter's test seam, so the second harness cannot evolve one-legged.
//
// The seam is the harness-adapter contract suite's (scripts/test-harness-
// adapter.mjs): the same fixture (scripts/lib/dsh-contracts/fake-acp-agent.mjs
// over stdio), the same contract surface (agent-runner/harness/adapter.js).
// This file pins the PARITY ITSELF — the ACP adapter must satisfy the exact
// surface check the dsh adapter satisfies, report only known capability keys
// with the ACP-honest values, and complete the start → stdio handshake →
// turn → stop lifecycle through the same calls — plus the cold-start family
// contract at the seam. The behavioral loop (empty-turn family, activeTurns,
// cancel, MCP passthrough) stays in the shared suite; nothing here repeats it.
//
//   node --test scripts/test-acp-adapter.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ADAPTER_CAPABILITIES, assertAdapter } from "../agent-runner/harness/adapter.js";
import { AcpHarnessAdapter } from "../agent-runner/harness/acp.js";
import { DshHarnessAdapter } from "../agent-runner/harness/dsh.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ACP = path.join(REPO_ROOT, "scripts", "lib", "dsh-contracts", "fake-acp-agent.mjs");
const SILENT_LOG = { log() {}, warn() {}, error() {} };

function acpAdapter({ mode = "normal" } = {}) {
  return new AcpHarnessAdapter({
    key: "acp-seam",
    spawnSpec: {
      command: process.execPath,
      args: [FAKE_ACP, `--mode=${mode}`],
      cwd: REPO_ROOT,
      env: { ...process.env, FAKE_ACP_REPLY: "seam ok" },
      provider: "seam-provider",
      model: "seam-model",
    },
    log: SILENT_LOG,
  });
}

test("[acp] contract parity: the second harness satisfies the exact surface check the dsh adapter satisfies", () => {
  // Same constructor-time loudness: assertAdapter must pass for BOTH adapters
  // with zero per-harness tolerance (no method presence, no unknown capability).
  const acp = acpAdapter();
  assert.doesNotThrow(() => assertAdapter(acp), "the ACP adapter passes the shared surface check");
  assert.equal(acp.name, "acp");

  const dsh = new DshHarnessAdapter({
    key: "dsh-seam",
    spawnSpec: { profile: "platform", patchPaths: [], cwd: REPO_ROOT, env: {}, provider: "p", model: "m", presetId: null },
    clientFactory: () => ({
      start() {},
      async initialize() {
        return { ok: true };
      },
      subscribe() {
        return { next: async () => new Promise(() => {}) };
      },
      async prompt() {
        return "msg";
      },
      async stop() {},
    }),
    log: SILENT_LOG,
  });
  assert.doesNotThrow(() => assertAdapter(dsh), "the dsh adapter passes the same check (the seam is shared)");

  // Parity: the same contract method set on both (start/turn/stop/pid/
  // capabilities are assertAdapter's core; ready/activeTurns/agentActiveTurns/
  // isActive are the manager's synchronous reads; request is the deep-control
  // lane both implement).
  const surface = ["start", "turn", "stop", "pid", "capabilities", "ready", "activeTurns", "agentActiveTurns", "isActive", "request"];
  for (const adapter of [acp, dsh]) {
    for (const member of surface) {
      assert.ok(adapter[member] !== undefined, `[${adapter.name}] contract member '${member}' exists`);
    }
  }
});

test("[acp] capability self-report: known keys only, the ACP-honest values", () => {
  const caps = acpAdapter().capabilities();
  for (const key of Object.keys(caps)) {
    assert.ok(ADAPTER_CAPABILITIES.includes(key), `capability '${key}' is in the known set`);
  }
  // Honest depth: what the ACP wire carries is true; dsh's platform depth is
  // explicitly false (callers degrade open, structured refusals name it).
  assert.deepEqual(caps, { liveModel: true, cancel: true, stream: true, perSessionPreset: false, cohost: false, asks: false });
});

test("[acp] lifecycle at the seam: start → stdio initialize handshake → turn → idempotent stop", async () => {
  const adapter = acpAdapter();
  assert.equal(adapter.ready, false, "a fresh adapter is not ready");
  assert.equal(adapter.pid(), null, "pid() is null before start");

  await adapter.start();
  assert.equal(adapter.ready, true, "the stdio initialize handshake leaves the adapter ready");
  assert.ok(Number.isInteger(adapter.pid()), "the spawned agent process is trackable by pid");

  const out = await adapter.turn("acp-seam-s1", "hello");
  assert.match(String(out?.text || ""), /seam ok/, "a turn over the stdio wire returns the assistant text");

  await adapter.stop();
  assert.equal(adapter.ready, false, "stop() clears readiness");
  await adapter.stop(); // idempotent — the manager may race a drain with shutdown
});

test("[acp] cold-start family at the seam: a dead agent fails start loudly, never a hang", async () => {
  const bad = new AcpHarnessAdapter({
    key: "acp-seam-dead",
    spawnSpec: { command: process.execPath, args: [FAKE_ACP, "--mode=nope"], cwd: REPO_ROOT, env: process.env },
    log: SILENT_LOG,
  });
  await assert.rejects(bad.start(), /initialize|exit|ACP/i, "a failed handshake surfaces as a start failure");
  assert.equal(bad.ready, false, "the failed cold start leaves nothing ready behind");
  await bad.stop(); // the failed handshake must not leave the process behind
});
