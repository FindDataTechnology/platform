#!/usr/bin/env node
// ── Desktop seat pairing E2E probe (add-desktop-fleet-runner ③ second cut) ──
//
// The pairing loop with REAL components from both repos, no production plane:
//   facade (real devices face + real sqlite store) ── mint → desktop cell
//   route (real pair endpoint, real settings.json write) → REAL agent-runner
//   reporting through the facade's public ingest forward → stub observer
//   (verifying the swapped service credential + desktop flag) → revocation
//   401s the very next ingest.
//
// Run: node scripts/probe-desktop-fleet-pairing.mjs

import http from "node:http";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WX = path.resolve(REPO, "..", "finddata", "fd-wanxing");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, fn) => fn().then(() => { results.push([name, true]); console.log(`  ✓ ${name}`); })
  .catch((e) => { results.push([name, false]); console.error(`  ✗ ${name}: ${e?.message}`); });

const listen = (app) => new Promise((r) => {
  const srv = app.listen(0, "127.0.0.1", () => r(srv));
});

// ── 1. stub observer (service credential only) ──────────────────────────────
const ingested = [];
const observerApp = express();
observerApp.use(express.json({ limit: "8mb" }));
observerApp.post("/ingest", (req, res) => {
  if (req.headers.authorization !== "Bearer svc-cred") return res.status(401).json({ error: "svc" });
  for (const e of req.body?.events ?? []) ingested.push(e);
  res.status(202).json({ ok: true });
});
const observer = await listen(observerApp);
const OBS = `http://127.0.0.1:${observer.address().port}`;

// ── 2. real facade devices face + real store ────────────────────────────────
const { createWanxingStore } = await import(path.join(WX, "services", "wanxing-facade", "store.js"));
const { createDeviceFace } = await import(path.join(WX, "services", "wanxing-facade", "devices.js"));
const store = createWanxingStore({ file: path.join(os.tmpdir(), `wx-pair-e2e-${Date.now()}.db`) });
let facadeBase = ""; // set once the port is known; publicBase() reads it live
const facadeApp = express();
facadeApp.use(express.json({ limit: "8mb" }));
const face = createDeviceFace({
  store,
  gate: async (req, res) => {
    if (req.headers["x-probe-identity"] === "owner") {
      req.consoleIdentity = { email: "owner@example.test", groups: [] };
      return true;
    }
    res.status(401).json({ error: "no identity" });
    return false;
  },
  observerCall: async (p, init = {}) =>
    fetch(`${OBS}${p}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: "Bearer svc-cred" } }),
  publicBase: () => facadeBase
});
face.register(facadeApp);
const facade = await listen(facadeApp);
const FACADE = `http://127.0.0.1:${facade.address().port}`;
facadeBase = FACADE;

let fleetToken = "";
let fleetUrl = "";

await check("mint → desktop pair → credentials persist into settings.json", async () => {
  const m = await fetch(`${FACADE}/api/wanxing/v1/console/devices/code`, {
    method: "POST", headers: { "x-probe-identity": "owner" },
  });
  assert.equal(m.status, 201);
  const { code } = await m.json();

  // The desktop cell's real pair route, pointed at the facade under test.
  const { registerWanxingFleetRoutes } = await import(path.join(REPO, "server", "routes", "wanxing-fleet.js"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-pair-desktop-"));
  const cellApp = express();
  cellApp.use(express.json());
  registerWanxingFleetRoutes({
    app: cellApp,
    env: {
      PLATFORM_DATA_DIR: dataDir,
      WANXING_PLUGIN_RUNNER_ID: "desktop-e2epair01",
      WANXING_CONSOLE_URL: FACADE,
    },
  });
  const cell = await listen(cellApp);
  const r = await fetch(`http://127.0.0.1:${cell.address().port}/api/wanxing/fleet/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machineName: "E2E 探针机" }),
  });
  assert.equal(r.status, 200);
  const doc = await r.json();
  fleetToken = doc.fleetToken || "";
  fleetUrl = doc.fleetUrl || "";
  cell.close();
  // The token itself never rides the pair response to the renderer in the
  // real app — this probe reads the settings file the way the runner will.
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  fleetUrl = saved.AGENT_RUNNER_FLEET_URL;
  fleetToken = saved.AGENT_RUNNER_FLEET_TOKEN;
  assert.match(fleetUrl, new RegExp(`^${FACADE}/api/wanxing/v1/fleet$`));
  assert.match(fleetToken, /^wxdesk-/);
});

await check("a real runner reports THROUGH the facade forward with desktop:true", async () => {
  // The facade forward is the public ingest door — point the runner at it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-pair-runner-"));
  const registry = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ agents: [] }));
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  const runner = spawn(process.execPath, [path.join(REPO, "agent-runner", "index.js")], {
    env: {
      ...process.env,
      AGENT_SERVING_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}`,
      AGENT_RUNNER_HOME: path.join(tmp, "home"),
      AGENT_RUNNER_HOST: "127.0.0.1",
      AGENT_RUNNER_PORT: "18792",
      AGENT_RUNNER_POD_MODE: "1",
      AGENT_RUNNER_DESKTOP: "1",
      AGENT_RUNNER_FLEET_ID: "desktop-e2epair01",
      AGENT_RUNNER_DEFAULT_ID: "cloud-default",
      AGENT_RUNNER_FLEET_URL: fleetUrl,
      AGENT_RUNNER_FLEET_TOKEN: fleetToken,
      AGENT_RUNNER_FLEET_SAMPLE_SECS: "2",
      AGENT_RUNNER_POLL_SECS: "2",
      AGENT_RUNNER_PROVIDER: "finddata",
      AGENT_RUNNER_MODEL: "deepseek-v4.1-flash",
      LLM_PROVIDERS_STORE: path.join(REPO, "llm-providers.json"),
      DSH_BIN: process.execPath,
      DSH_BIN_ARGS: JSON.stringify([path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")]),
      DSH_MATRIX_INSTALL_ROOT: path.join(tmp, "no-matrix"),
      AGENT_RUNNER_SEED_HOME: path.join(os.homedir(), ".dsh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stderr.on("data", () => {});
  try {
    const deadline = Date.now() + 45_000;
    let row = null;
    while (Date.now() < deadline) {
      row = ingested.find((e) => e.kind === "runner_stats" && e.runner === "desktop-e2epair01") ?? null;
      if (row) break;
      await sleep(500);
    }
    assert.ok(row, "runner_stats reached the observer THROUGH the facade forward");
    assert.equal(row.payload.desktop, true);
  } finally {
    runner.kill("SIGTERM");
    await sleep(1500);
    runner.kill("SIGKILL");
    registry.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check("revocation 401s the very next ingest through the same door", async () => {
  const d = await fetch(`${FACADE}/api/wanxing/v1/console/devices/desktop-e2epair01`, {
    method: "DELETE", headers: { "x-probe-identity": "owner" },
  });
  assert.equal(d.status, 200);
  const r = await fetch(`${fleetUrl}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fleetToken}` },
    body: JSON.stringify({ events: [{ id: "x", source: "s", agent: "a", kind: "runner_stats", ts: 1, payload: {} }] }),
  });
  assert.equal(r.status, 401, "the revoked seat's token fails closed at the forward");
});

facade.close();
observer.close();
store.close();
await sleep(200);

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED — pairing loop is live end to end`);
process.exit(failed.length ? 1 : 0);
