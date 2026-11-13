#!/usr/bin/env node
// ── Desktop fleet console acceptance probe (add-desktop-fleet-console 4.1) ───
//
// Boots the REAL cell route module on an express app, plus a stub runner
// (/health) and a stub registry (/api/agents), then asserts the spec's four
// observable behaviors end to end over HTTP:
//   live proxies verbatim / live degrades 503 / catalog projects read-only /
//   unconfigured registry degrades 503. No production plane is touched.
//
// Run: node scripts/probe-desktop-fleet-console.mjs

import express from "express";
import assert from "node:assert/strict";
import { registerWanxingFleetRoutes } from "../server/routes/wanxing-fleet.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const results = [];
const check = (name, fn) => fn().then(() => { results.push([name, true]); console.log(`  ✓ ${name}`); })
  .catch((e) => { results.push([name, false]); console.error(`  ✗ ${name}: ${e?.message}`); });

const HEALTH = {
  ok: true,
  agents: [
    { key: "packs-pk-probe-a", path: "/packs/pk-probe/a", port: 8819, state: "serving", version: 2 },
    { key: "packs-pk-probe-b", path: "/packs/pk-probe/b", port: 8820, state: "resident", version: 2 },
  ],
  children: 1,
  queued: 0,
  budget: 216,
  budgetMb: 2048,
};

// ── stub upstreams ───────────────────────────────────────────────────────────
const runnerApp = express();
runnerApp.get("/health", (_req, res) => res.json(HEALTH));
const runner = await listen(runnerApp);

const registryApp = express();
registryApp.get("/api/agents", (req, res) => {
  assert.equal(new URL(req.url, "http://x").searchParams.get("limit"), "500", "limit rides along");
  res.json({
    agents: [
      { path: "/packs/pk1/agent-x", name: "Agent X", description: "desc", version: "3", tags: ["finance"], is_enabled: true, supported_protocol: "a2a", metadata: { internal: "must-not-leak" } },
      { path: "/packs/pk1/off", name: "Off", is_enabled: false, supported_protocol: "a2a" },
      { path: "/packs/pk1/mcp-only", name: "Mcp", is_enabled: true, supported_protocol: "mcp" },
    ],
  });
});
const registry = await listen(registryApp);

// ── the real cell lane under test ────────────────────────────────────────────
const app = express();
registerWanxingFleetRoutes({
  app,
  env: {
    WANXING_RUNNER_URL: `http://127.0.0.1:${runner.address().port}`,
    AGENT_SERVING_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}`,
    AGENT_SERVING_REGISTRY_TOKEN: "probe",
  },
});
const cell = await listen(app);
const base = `http://127.0.0.1:${cell.address().port}`;

await check("live proxies the runner health verbatim", async () => {
  const r = await fetch(`${base}/api/wanxing/fleet/live`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), HEALTH);
});

await check("catalog projects only enabled a2a entries, read-only fields", async () => {
  const r = await fetch(`${base}/api/wanxing/fleet/catalog`);
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.deepEqual(doc.agents, [
    { path: "/packs/pk1/agent-x", name: "Agent X", description: "desc", version: "3", tags: ["finance"] },
  ]);
  assert.ok(!JSON.stringify(doc).includes("must-not-leak"), "metadata internals never leak");
});

// Degradation: point the lane at a dead runner port.
const deadApp = express();
registerWanxingFleetRoutes({
  app: deadApp,
  env: { WANXING_RUNNER_URL: "http://127.0.0.1:1", AGENT_SERVING_REGISTRY_URL: "" },
});
const deadCell = await listen(deadApp);
const deadBase = `http://127.0.0.1:${deadCell.address().port}`;

await check("runner down degrades to 503 runner_not_running", async () => {
  const r = await fetch(`${deadBase}/api/wanxing/fleet/live`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "runner_not_running");
});

await check("unconfigured registry degrades to 503 registry_not_configured", async () => {
  const r = await fetch(`${deadBase}/api/wanxing/fleet/catalog`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "registry_not_configured");
});

for (const s of [runner, registry, cell, deadCell]) s.close();
await sleep(100);

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED — fleet console lane is live`);
process.exit(failed.length ? 1 : 0);
