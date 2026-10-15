// Unit tests for the gateway's cell fleet reporter (unify-wanxing-management-plane).
// Covers the cell-gateway spec scenarios:
//   - unconfigured default changes nothing (null reporter, zero fetches)
//   - live cells are sampled over the internal identity channel and reported
//     as one cell_stats event per cell per tick, addressed by cell identity
//   - a dead/erroring cell degrades to absence; the rest still report
//   - ingest failures are log-only and never throw into the caller
//
// Run: node --test scripts/test-gateway-fleet-cells.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCellFleetReporter } from "../gateway/fleet-cells.js";

const fakeRegistry = (cells) => ({ cells: new Map(cells) });

function recordingFetch({ cells = {}, ingestStatus = 202 } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith("/ingest")) {
      return { ok: ingestStatus >= 200 && ingestStatus < 300, status: ingestStatus, json: async () => ({}) };
    }
    const body = cells[url];
    if (body === "fail") throw new Error("connection refused");
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const ENV = { FLEET_INGEST_URL: "https://fleet.example.test", FLEET_INGEST_TOKEN: "tok" };

test("unconfigured default: no reporter, no traffic", () => {
  const fetchImpl = recordingFetch();
  const r = createCellFleetReporter({
    registry: fakeRegistry([["u@x.test", { port: 4001, state: "running" }]]),
    secret: "s",
    fetchImpl,
    env: {},
  });
  assert.equal(r, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test("one cell_stats event per live cell per tick, over the internal identity channel", async () => {
  const fetchImpl = recordingFetch({
    cells: {
      "http://127.0.0.1:4001/api/tasks/stats": { jobs: 3, executions: { running: 1, queued: 0 }, workers: { cap: 0, busy: 0, idle: 0 }, recent: { done: 2, failed: 0, interrupted: 0 }, agentBusy: true },
      "http://127.0.0.1:4002/api/tasks/stats": { jobs: 0, executions: { running: 0, queued: 2 }, workers: { cap: 4, busy: 1, idle: 3 }, recent: { done: 0, failed: 1, interrupted: 0 }, agentBusy: false },
    },
  });
  const logs = [];
  const r = createCellFleetReporter({
    registry: fakeRegistry([
      ["a@x.test", { port: 4001, state: "running" }],
      ["b@x.test", { port: 4002, state: "running" }],
    ]),
    secret: "gw-secret",
    fetchImpl,
    env: ENV,
    startImmediate: false,
    log: (m) => logs.push(m),
    now: () => 1_700_000_000_000,
  });
  await r.tick();

  // Sampling used the gateway's forged-identity channel per cell.
  const samples = fetchImpl.calls.filter((c) => c.url.includes("/api/tasks/stats"));
  assert.equal(samples.length, 2);
  for (const s of samples) {
    assert.equal(s.opts.headers["x-cloud-gateway-secret"], "gw-secret");
    assert.ok(String(s.opts.headers["x-forwarded-email"]).endsWith("@x.test"));
  }

  const ingest = fetchImpl.calls.find((c) => c.url.endsWith("/ingest"));
  assert.ok(ingest, "ingest posted");
  assert.equal(ingest.opts.headers.authorization, "Bearer tok");
  const events = JSON.parse(ingest.opts.body).events;
  assert.equal(events.length, 2);
  const byAgent = Object.fromEntries(events.map((e) => [e.agent, e]));
  assert.ok(byAgent["cell:a@x.test"]);
  assert.ok(byAgent["cell:b@x.test"]);
  for (const e of events) {
    assert.equal(e.kind, "cell_stats");
    assert.equal(e.source, "cell-sampler");
    assert.equal(typeof e.id, "string");
    assert.equal(e.ts, 1_700_000_000_000);
    assert.equal(typeof e.payload.jobs, "number");
  }
  assert.equal(byAgent["cell:b@x.test"].payload.executions.queued, 2);
  assert.deepEqual(logs, []);
  r.stop();
});

test("dead or stopping cells degrade to absence; the rest still report", async () => {
  const fetchImpl = recordingFetch({
    cells: { "http://127.0.0.1:4002/api/tasks/stats": { jobs: 1, executions: { running: 0, queued: 0 }, workers: { cap: 0, busy: 0, idle: 0 }, recent: { done: 0, failed: 0, interrupted: 0 }, agentBusy: false } },
  });
  const r = createCellFleetReporter({
    registry: fakeRegistry([
      ["dead@x.test", { port: 4001, state: "running" }], // fetch throws
      ["gone@x.test", { port: 4003, state: "stopping" }], // skipped outright
      ["live@x.test", { port: 4002, state: "running" }],
    ]),
    secret: "s",
    fetchImpl,
    env: ENV,
    startImmediate: false,
    log: () => {},
  });
  await r.tick();
  const ingest = fetchImpl.calls.find((c) => c.url.endsWith("/ingest"));
  const events = JSON.parse(ingest.opts.body).events;
  assert.deepEqual(events.map((e) => e.agent), ["cell:live@x.test"]);
  r.stop();
});

test("ingest failure is log-only and never throws", async () => {
  const fetchImpl = recordingFetch({
    cells: { "http://127.0.0.1:4001/api/tasks/stats": { jobs: 1 } },
    ingestStatus: 503,
  });
  const logs = [];
  const r = createCellFleetReporter({
    registry: fakeRegistry([["u@x.test", { port: 4001, state: "running" }]]),
    secret: "s",
    fetchImpl,
    env: ENV,
    startImmediate: false,
    log: (m) => logs.push(m),
  });
  await assert.doesNotReject(() => r.tick());
  assert.equal(logs.filter((l) => l.includes("503") || l.includes("dropping")).length, 1);
  r.stop();
});
