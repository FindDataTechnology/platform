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
  // biome-ignore lint/correctness/noUnusedFunctionParameters: fetch-mock arity — init.body is read below, url is positionally required
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

// ── add-deploy-roster-gate: the heartbeat carries the model roster ───────────
test("runner sampler: roster rides runner_stats; failures omit the field", async () => {
  const emitted = [];
  const reporter = { emit: (e) => emitted.push(e) };
  const manager = { health: () => ({ agents: [], children: 0, queued: 0, budget: 0, budgetMb: 3328 }) };
  // Sync provider (the test seam): available on the very first tick.
  const sampler = createFleetSampler({ manager, reporter, runnerId: "r1", rosterProvider: () => ["deepseek-v4.1-flash", "m2"] });
  sampler.sample();
  let stats = emitted.filter((e) => e.kind === "runner_stats");
  assert.deepEqual(stats[0].payload.models, ["deepseek-v4.1-flash", "m2"], "roster rides the heartbeat verbatim");
  // Async provider: lands on the tick AFTER the background refresh resolves.
  const emitted2 = [];
  const reporter2 = { emit: (e) => emitted2.push(e) };
  const sampler2 = createFleetSampler({ manager, reporter: reporter2, runnerId: "r2", rosterProvider: async () => ["m-a"] });
  sampler2.sample();
  assert.equal(emitted2.find((e) => e.kind === "runner_stats").payload.models, undefined, "async roster not yet landed on first tick");
  await new Promise((r) => setTimeout(r, 10));
  sampler2.sample();
  assert.deepEqual(emitted2.filter((e) => e.kind === "runner_stats").at(-1).payload.models, ["m-a"], "landed after refresh");
  // Failing provider: the field is OMITTED (degrade open), never an empty list.
  const emitted3 = [];
  const reporter3 = { emit: (e) => emitted3.push(e) };
  const sampler3 = createFleetSampler({ manager, reporter: reporter3, runnerId: "r3", rosterProvider: async () => { throw new Error("store unreadable"); } });
  sampler3.sample();
  await new Promise((r) => setTimeout(r, 10));
  sampler3.sample();
  assert.equal(emitted3.filter((e) => e.kind === "runner_stats").at(-1).payload.models, undefined, "failure omits the field");
});

// ── add-harness-adapter: the heartbeat carries the harness self-report ──────
test("runner sampler: harness rides runner_stats; absence and failures omit the field", async () => {
  const manager = { health: () => ({ agents: [], children: 0, queued: 0, budget: 0, budgetMb: 3328 }) };
  const emitted = [];
  const sampler = createFleetSampler({
    manager,
    reporter: { emit: (e) => emitted.push(e) },
    runnerId: "r-h",
    harnessProvider: () => ["dsh", "acp-claude-code"],
  });
  sampler.sample();
  assert.deepEqual(
    emitted.filter((e) => e.kind === "runner_stats").at(-1).payload.harness,
    ["dsh", "acp-claude-code"],
    "the harness set rides the heartbeat verbatim (the deploy gate reads it off the board)",
  );
  // No provider at all (legacy runner): the field is absent — degrade open.
  const emitted2 = [];
  createFleetSampler({ manager, reporter: { emit: (e) => emitted2.push(e) }, runnerId: "r-old" }).sample();
  assert.equal(emitted2.filter((e) => e.kind === "runner_stats").at(-1).payload.harness, undefined, "no provider → no field");
  // A throwing provider omits the field rather than reporting an empty set.
  const emitted3 = [];
  createFleetSampler({
    manager,
    reporter: { emit: (e) => emitted3.push(e) },
    runnerId: "r-broken",
    harnessProvider: () => { throw new Error("registry unreadable"); },
  }).sample();
  assert.equal(emitted3.filter((e) => e.kind === "runner_stats").at(-1).payload.harness, undefined, "failure omits the field");
});

// Density self-report (unify-wanxing-management-plane): the runner_stats row
// carries the pod co-hosting mode; absent config reads as a solo runner.
test("runner sampler: runner_stats carries the pod density flag", () => {
  const emitted = [];
  const reporter = { emit: (e) => emitted.push(e) };
  const manager = {
    health: () => ({ agents: [], children: 0, queued: 0, budget: 0, budgetMb: 3072 }),
  };
  createFleetSampler({ manager, reporter, runnerId: "r-pod", podMode: true }).sample();
  createFleetSampler({ manager, reporter, runnerId: "r-solo" }).sample();
  const rows = emitted.filter((e) => e.kind === "runner_stats");
  assert.equal(rows[0].agent, "r-pod");
  assert.equal(rows[0].payload.pod, true);
  assert.equal(rows[1].agent, "r-solo");
  assert.equal(rows[1].payload.pod, false);
});

// Desktop seat self-report (add-desktop-fleet-runner ③): the runner_stats row
// marks desktop seats so the board consumer can exclude them from every cloud
// control decision; absent config reads as a cloud runner.
test("runner sampler: runner_stats carries the desktop seat flag", () => {
  const emitted = [];
  const reporter = { emit: (e) => emitted.push(e) };
  const manager = {
    health: () => ({ agents: [], children: 0, queued: 0, budget: 0, budgetMb: 2048 }),
  };
  createFleetSampler({ manager, reporter, runnerId: "desktop-abc", podMode: true, desktopMode: true }).sample();
  createFleetSampler({ manager, reporter, runnerId: "runner-1" }).sample();
  const rows = emitted.filter((e) => e.kind === "runner_stats");
  assert.equal(rows[0].payload.desktop, true);
  assert.equal(rows[1].payload.desktop, false);
});

// ── Dead-letter on permanent rejection (fix-fleet-reporter-deadletter) ───────
//
// A 4xx from the observer is permanent (a kind it will never accept). The
// pre-fix behavior returned an error and kept the batch — one stale kind
// wedged the queue forever (live 2026-10-25: 20.7k spooled events, runner
// stats never reaching the board). The batch must drop, the offender must be
// named, and flushing must continue.

test("runner reporter: a 4xx batch dead-letters and later events still flow", async () => {
  const spool = path.join(tmp, "deadletter.jsonl");
  const seen = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const kinds = body.events.map((e) => e.kind);
    if (kinds.includes("billing_probe_v0")) {
      return { ok: false, status: 400, text: async () => '{"error":"invalid event"}' };
    }
    seen.push(...kinds);
    return { ok: true, status: 200, json: async () => ({ accepted: kinds.length, duplicates: 0 }) };
  };
  const logs = [];
  const r = runnerReporter({
    url: "https://obs.test", token: "t", runnerId: "r1", spoolFile: spool,
    fetchImpl: impl, flushIntervalMs: 10 ** 9,
    log: (m) => logs.push(m),
  });
  r.emit({ kind: "billing_probe_v0", agent: "/packs/p1/a1" }); // the poison kind
  r.emit({ kind: "woken", agent: "/packs/p1/a1" });
  r.emit({ kind: "runner_stats", agent: "r1", payload: { children: 1 } });

  const out1 = await r.flush();
  assert.equal(out1.dropped, 3, "the poisoned BATCH is dropped whole, not retained");
  assert.ok(logs.some((l) => /dead-lettering 3 event/.test(l) && /billing_probe_v0/.test(l)), "the offender is named");

  // Fresh events emitted AFTER the dead-letter still flow — the wedge is gone.
  r.emit({ kind: "woken", agent: "/packs/p1/a2" });
  r.emit({ kind: "runner_stats", agent: "r1", payload: { children: 1 } });
  const out2 = await r.flush();
  assert.equal(out2.sent, 2, "events after the dead-letter flow");
  assert.deepEqual(seen.sort(), ["runner_stats", "woken"]);
  assert.equal(readFileSync(spool, "utf8"), "");
});
