#!/usr/bin/env node
// ── Desktop fleet uplink acceptance probe (add-desktop-fleet-runner ③) ───────
//
// Proves the uplink chain with REAL processes and no production plane:
// a stub ingest endpoint (the observer's /ingest shape) receives events from
// a real agent-runner child started with the exact env the supervisor's
// desktop descriptor injects — and the runner_stats row carries
// desktop:true (the flag the board consumer uses to exclude the seat from
// cloud control), plus pod:true (density self-report). The scheduler-side
// exclusion is covered by unit tests; this probe pins the reporter side.
//
// Run: node scripts/probe-desktop-fleet-uplink.mjs

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stub ingest (observer shape) + stub registry (empty seat slice) ─────────
const events = [];
const ingest = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/ingest")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      for (const e of JSON.parse(body).events ?? []) events.push(e);
    } catch { /* not ours */ }
    res.writeHead(202).end("{}");
  });
});
await new Promise((r) => ingest.listen(0, "127.0.0.1", r));
const INGEST_PORT = ingest.address().port;

const registry = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ agents: [] })); // the seat hosts nothing — stats only
});
await new Promise((r) => registry.listen(0, "127.0.0.1", r));

// ── real runner with the descriptor's desktop env ───────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-uplink-probe-"));
const runner = spawn(process.execPath, [path.join(REPO, "agent-runner", "index.js")], {
  env: {
    ...process.env,
    AGENT_SERVING_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}`,
    AGENT_SERVING_REGISTRY_TOKEN: "probe",
    AGENT_RUNNER_HOME: path.join(tmp, "home"),
    AGENT_RUNNER_HOST: "127.0.0.1",
    AGENT_RUNNER_PORT: "18791",
    AGENT_RUNNER_POD_MODE: "1",
    AGENT_RUNNER_DESKTOP: "1",
    AGENT_RUNNER_FLEET_ID: "desktop-uplink-probe",
    AGENT_RUNNER_DEFAULT_ID: "cloud-default",
    AGENT_RUNNER_FLEET_URL: `http://127.0.0.1:${INGEST_PORT}`,
    AGENT_RUNNER_FLEET_TOKEN: "probe-ingest",
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
runner.stdout.on("data", (b) => process.stdout.write(`[runner] ${b}`));
runner.stderr.on("data", (b) => process.stderr.write(`[runner:err] ${b}`));

let failed = 0;
try {
  console.log(`[probe] ingest :${INGEST_PORT}; waiting for the seat's runner_stats…`);
  const deadline = Date.now() + 45_000;
  let row = null;
  while (Date.now() < deadline) {
    row = events.find((e) => e.kind === "runner_stats" && e.runner === "desktop-uplink-probe") ?? null;
    if (row) break;
    await sleep(500);
  }
  if (!row) {
    console.error("  ✗ no runner_stats row arrived at the ingest endpoint");
    failed += 1;
  } else {
    console.log(`  ✓ runner_stats ingested (source ${row.source})`);
    if (row.payload.desktop === true) console.log("  ✓ desktop: true rides the row — board-side control exclusion is armed");
    else { console.error(`  ✗ desktop flag missing/false: ${JSON.stringify(row.payload)}`); failed += 1; }
    if (row.payload.pod === true) console.log("  ✓ pod: true rides the row (density self-report)");
    else { console.error("  ✗ pod flag missing"); failed += 1; }
  }
} finally {
  runner.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  runner.kill("SIGKILL");
  ingest.close();
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED — desktop seat reports as scheduling-invisible");
process.exit(failed ? 1 : 0);
