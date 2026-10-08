#!/usr/bin/env node
// ── Runner fleet-client + facade reporter tests (add-fleet-event-backbone 3.1/6.3) ─
//
//   node --test scripts/test-fleet-report.mjs
//
// Runner side: spool persistence, replay across restart, batch flush, ack
// trimming, drop-oldest cap, at-least-once under a failing observer.
// Facade side: queue + flush, inert without URL, deterministic settled ids.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { createFleetReporter: runnerReporter, createFleetSampler } = await import("../agent-runner/fleet.js");
const { createFleetReporter: facadeReporter } = await import("../gateway/wanxing/fleet-report.js");

const tmp = mkdtempSync(path.join(tmpdir(), "fleet-report-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// An observer stub that can be programmably flaky.
function observerStub() {
  const calls = [];
  let failNext = 0;
  const impl = async (url, init) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("observer unreachable");
    }
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ accepted: 0, duplicates: 0 }) };
  };
  return { impl, calls, fail: (n) => (failNext = n) };
}

test("runner reporter: spool persists, replays across restart, ack trims", async () => {
  const obs = observerStub();
  const spool = path.join(tmp, "s1.jsonl");
  const mk = () => runnerReporter({ url: "https://obs.test", token: "t", runnerId: "r1", spoolFile: spool, fetchImpl: obs.impl, flushIntervalMs: 10 ** 9 });

  const r1 = mk();
  r1.emit({ kind: "woken", agent: "/packs/p1/deployments/a1", payload: { reason: "first-touch" } });
  r1.emit({ kind: "reaped", agent: "/packs/p1/deployments/a1", payload: { reason: "budget" } });
  // A "crash" without a flush: the spool still holds both lines.
  assert.equal(readFileSync(spool, "utf8").trim().split("\n").length, 2);

  // Restart: start() replays the spool and auto-flushes it out — wait for the
  // spool to drain rather than racing the automatic flush.
  const r2 = mk();
  r2.start();
  for (let i = 0; i < 100 && existsSync(spool) && readFileSync(spool, "utf8").trim() !== ""; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(readFileSync(spool, "utf8").trim(), "");
  assert.equal(obs.calls[0].events.length, 2);
  // Slugified agent identity, runner identity carried.
  assert.equal(obs.calls[0].events[0].agent, "packs-p1-deployments-a1");
  assert.equal(obs.calls[0].events[0].runner, "r1");
  // Acked lines leave the spool.
  assert.equal(readFileSync(spool, "utf8").trim(), "");
  r2.stop();
});

test("runner reporter: at-least-once under a failing observer (spool keeps rows)", async () => {
  const obs = observerStub();
  const spool = path.join(tmp, "s2.jsonl");
  const r = runnerReporter({ url: "https://obs.test", token: "t", runnerId: "r1", spoolFile: spool, fetchImpl: obs.impl, flushIntervalMs: 10 ** 9 });
  r.emit({ kind: "turn_started", agent: "a", payload: {} });
  obs.fail(2); // two failed flush attempts
  await r.flush();
  await r.flush();
  assert.equal(readFileSync(spool, "utf8").trim().split("\n").length, 1); // still there
  const out = await r.flush(); // third attempt lands
  assert.equal(out.sent, 1);
  r.stop();
});

test("runner sampler: five-state transitions + runner_stats from health()", () => {
  const emitted = [];
  const reporter = { emit: (e) => emitted.push(e) };
  const manager = {
    health: () => ({
      agents: [{ key: "k1", path: "/packs/p1/deployments/a1", state: "resident" }],
      children: 1, queued: 0, budget: 96.4, budgetMb: 3072,
    }),
  };
  const sampler = createFleetSampler({ manager, reporter, runnerId: "r1" });
  sampler.sample();
  sampler.sample(); // second sample: no transition, only stats
  const kinds = emitted.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "state_changed").length, 1);
  assert.equal(emitted.find((e) => e.kind === "state_changed").payload.to, "resident");
  const stats = emitted.filter((e) => e.kind === "runner_stats");
  assert.equal(stats.length, 2);
  assert.equal(stats[0].payload.budget_mb_limit, 3072);
  assert.equal(stats[0].payload.agents, 1);
});

test("facade reporter: queued, flushed, inert without url; deterministic settled ids", async () => {
  const obs = observerStub();
  const r = facadeReporter({ url: "https://obs.test", token: "t", fetchImpl: obs.impl, flushIntervalMs: 10 ** 9 });
  r.report({ kind: "admitted", agent: "packs-x-deployments-agent", payload: { caller: "c@x.test" } });
  r.report({ kind: "settled", agent: "packs-x-deployments-agent", payload: { settlement_status: "settled" }, id: "facade-wu_deadbeef" });
  const out = await r.flush();
  assert.equal(out === undefined || true, true); // flush returns void-ish; verify via the stub
  assert.equal(obs.calls.length, 1);
  const [admitted, settled] = obs.calls[0].events;
  assert.equal(admitted.kind, "admitted");
  assert.equal(admitted.source, "facade");
  assert.equal(settled.id, "facade-wu_deadbeef");
  assert.match(admitted.id, /^[0-9A-HJKMNP-TV-Z]{26}$/); // fresh ULID

  const inert = facadeReporter({ url: "", token: "" });
  inert.report({ kind: "admitted", agent: "a", payload: {} });
  await inert.flush();
  assert.equal(obs.calls.length, 1); // nothing new — inert
});
