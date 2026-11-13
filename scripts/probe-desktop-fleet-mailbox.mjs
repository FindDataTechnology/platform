#!/usr/bin/env node
// ── Seat mailbox E2E probe (add-desktop-fleet-runner ④) ─────────────────────
//
// The full inbound loop with REAL components from both repos: a real facade
// (devices face for pairing + mailbox face + real sqlite) receives a task,
// the REAL desktop runner polls it over the per-seat lane, runs a REAL dsh
// turn (real LLM), settles the result, and the console read retrieves it.
//
// Run: node scripts/probe-desktop-fleet-mailbox.mjs

import http from "node:http";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WX = path.resolve(REPO, "..", "finddata", "fd-wanxing");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, fn) => fn().then(() => { results.push([name, true]); console.log(`  ✓ ${name}`); })
  .catch((e) => { results.push([name, false]); console.error(`  ✗ ${name}: ${e?.message}`); });
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const listen = (app) => new Promise((r) => {
  const srv = app.listen(0, "127.0.0.1", () => r(srv));
});

// ── the facade under test: devices + mailbox over one real store ────────────
const { createWanxingStore } = await import(path.join(WX, "services", "wanxing-facade", "store.js"));
const { createDeviceFace } = await import(path.join(WX, "services", "wanxing-facade", "devices.js"));
const { createMailboxFace } = await import(path.join(WX, "services", "wanxing-facade", "mailbox.js"));
const store = createWanxingStore({ file: path.join(os.tmpdir(), `wx-mb-e2e-${Date.now()}.db`) });
const gate = async (req, res) => {
  if (req.headers["x-probe-identity"] === "owner") {
    req.consoleIdentity = { email: "owner@example.test", groups: [] };
    return true;
  }
  res.status(401).json({ error: "no identity" });
  return false;
};
const seatAuth = (req) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token.startsWith("wxdesk-")) return null;
  const row = store.deviceByTokenHash(sha256(token));
  return row ? { runnerId: row.runner_id } : null;
};
let facadeBase = "";
const facadeApp = express();
facadeApp.use(express.json({ limit: "256kb" }));
createDeviceFace({
  store, gate,
  observerCall: async () => { throw new Error("observer not part of this probe"); },
  publicBase: () => facadeBase,
  log: () => {},
}).register(facadeApp);
createMailboxFace({ store, gate, seatAuth, log: (m) => console.log(`[mailbox] ${m}`) }).register(facadeApp);
const facade = await listen(facadeApp);
const FACADE = `http://127.0.0.1:${facade.address().port}`;
facadeBase = FACADE;

// ── stub registry: the seat's slice (one desktop_seat entry) ────────────────
const AGENT_PATH = "/packs/pk-mb/probe-agent";
const registryApp = http.createServer((req, res) => {
  if (req.url.startsWith("/api/agents")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      agents: [{
        path: AGENT_PATH, supported_protocol: "a2a", is_enabled: true,
        name: "Mailbox Probe Agent", description: "④", version: "1", skills: [], tags: [],
        metadata: {
          protocol: "a2a", packId: "pk-mb", packVersion: 1, agentId: "probe-agent",
          agentName: "信箱探针", persona: "你是信箱验收探针，简短作答。", skills: [], mcpServers: [],
          runner_id: "desktop-e2embx001", desktop_seat: true,
        },
      }],
    }));
  }
  res.writeHead(404).end();
});
const registry = await listen(registryApp);

// ── pair a seat, then boot the REAL runner pointed at the facade ───────────
const m = await fetch(`${FACADE}/api/wanxing/v1/console/devices/code`, { method: "POST", headers: { "x-probe-identity": "owner" } });
const { code } = await m.json();
const pairR = await fetch(`${FACADE}/api/wanxing/v1/console/devices/redeem`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, runnerId: "desktop-e2embx001", machineName: "信箱探针机" }),
});
assert.equal(pairR.status, 201);
const { fleetUrl, fleetToken } = await pairR.json();
console.log(`[probe] seat paired; fleet lane ${fleetUrl}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-mb-runner-"));
const runner = spawn(process.execPath, [path.join(REPO, "agent-runner", "index.js")], {
  env: {
    ...process.env,
    AGENT_SERVING_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}`,
    AGENT_SERVING_REGISTRY_TOKEN: "probe",
    AGENT_RUNNER_HOME: path.join(tmp, "home"),
    AGENT_RUNNER_HOST: "127.0.0.1",
    AGENT_RUNNER_PORT: "18793",
    AGENT_RUNNER_POD_MODE: "1",
    AGENT_RUNNER_DESKTOP: "1",
    AGENT_RUNNER_FLEET_ID: "desktop-e2embx001",
    AGENT_RUNNER_DEFAULT_ID: "cloud-default",
    AGENT_RUNNER_FLEET_URL: fleetUrl,
    AGENT_RUNNER_FLEET_TOKEN: fleetToken,
    AGENT_RUNNER_FLEET_SAMPLE_SECS: "4",
    AGENT_RUNNER_MAILBOX_POLL_SECS: "2",
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

async function waitFor(fn, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1000);
  }
}

try {
  await check("the seat's agent hosts on the real runner (cold start)", async () => {
    await waitFor(async () => {
      const r = await fetch("http://127.0.0.1:18793/health").catch(() => null);
      if (!r?.ok) return null;
      const j = await r.json();
      return (j.agents ?? []).some((a) => a.path === AGENT_PATH) ? j : null;
    }, "the agent to be hosted");
  });

  let taskId = "";
  await check("an external task deposits into the seat's box", async () => {
    const r = await fetch(`${FACADE}/api/wanxing/v1/seats/desktop-e2embx001/mailbox`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-probe-identity": "owner" },
      body: JSON.stringify({ agentPath: AGENT_PATH, text: "请只回复四个字：信箱就绪" }),
    });
    assert.equal(r.status, 201);
    taskId = (await r.json()).taskId;
    assert.match(taskId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  await check("the runner polls, runs a REAL turn, and settles", async () => {
    const task = await waitFor(async () => {
      const r = await fetch(`${FACADE}/api/wanxing/v1/console/mailbox/${taskId}`, { headers: { "x-probe-identity": "owner" } });
      if (!r.ok) return null;
      const doc = await r.json();
      return doc.status === "done" ? doc : null;
    }, "the task to settle");
    console.log(`      result: ${JSON.stringify((task.result || "").slice(0, 120))}`);
    assert.ok((task.result || "").length > 0, "a real LLM reply came back through the box");
  });
} finally {
  runner.kill("SIGTERM");
  await sleep(1500);
  runner.kill("SIGKILL");
  facade.close();
  registry.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED — the desktop seat serves external tasks through the mailbox`);
process.exit(failed.length ? 1 : 0);
