// ── Shared browser lane: process supervision sentinels ─────────────────────
//
// slim-browser-lane-footprint 1.2 (one CLI per pod, no --shared-browser-context)
// and 2.4 (a dead shared endpoint never grows a per-cell playwright). Both are
// process-table properties, so this file asserts on the real `ps` output of a
// service started with a FAKE @playwright/mcp: the fake records its argv and
// listens on --port, which is exactly the contract the frontend relies on.
//
// Why a fake and not the real CLI: the pin lives in the image
// (/opt/browser-mcp) and CI has no chromium, but the properties under test are
// argv shape and process count — those are decided by our code, not the CLI.
//
// Run: node --test scripts/test-browser-lane-supervisor.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserLaneService, upstreamArgs } from "../server/browser-lane-service.js";

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// A stand-in for @playwright/mcp's cli.js: records argv, serves its --port, and
// lives until killed (so the supervisor's restart path is observable).
function writeFakeCli(dir, recordPath) {
  const path = join(dir, "fake-playwright-mcp-cli.js");
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, pid: process.pid, at: Date.now() }) + "\\n");
const portIdx = argv.indexOf("--port");
const port = Number(argv[portIdx + 1]);
const server = createServer((_req, res) => res.writeHead(200).end("ok"));
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`,
  );
  return path;
}

function readRecords(recordPath) {
  try {
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function processesRunning(fragment) {
  const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment) && !line.includes("ps -eo"));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 15000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(stepMs);
  }
  return false;
}

test("1.2 the pod runs exactly one CLI and its argv keeps contexts per-session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-lane-supervisor-"));
  const recordPath = join(dir, "argv.log");
  const cli = writeFakeCli(dir, recordPath);
  const port = await freePort();
  const service = createBrowserLaneService({
    env: {
      ...process.env,
      BROWSER_SHARED_PORT: String(await freePort()),
      BROWSER_SHARED_UPSTREAM_PORT: String(port),
      BROWSER_SHARED_OUTPUT_ROOT: join(dir, "output"),
      BROWSER_MCP_CLI: cli,
      // Attach mode: no chromium needed for a fake CLI that never launches one.
      BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
    },
    identifyCell: () => ({ cellId: null, reason: "test" }),
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await service.start();
    assert.ok(await waitFor(() => processesRunning(cli).length === 1), "exactly one CLI process");
    const [first] = readRecords(recordPath);
    assert.ok(first, "the fake CLI recorded its argv");
    assert.ok(first.argv.includes("--isolated"), "--isolated keeps the profile in memory");
    assert.equal(
      first.argv[first.argv.indexOf("--host") + 1],
      "127.0.0.1",
      "the CLI must bind the literal loopback address, not `localhost`",
    );
    assert.ok(first.argv.includes("--port"), "the CLI serves SSE on --port");
    assert.ok(first.argv.includes("--output-dir"), "--output-dir is the shared artifact root");
    assert.ok(first.argv.includes("--config"), "launch options ride the config file, as in the shim");
    assert.equal(
      first.argv.includes("--shared-browser-context"),
      false,
      "--shared-browser-context would collapse per-cell isolation — it must never be passed",
    );
    // Restart supervision: kill the CLI, expect the SAME service to bring it
    // back (cells recover without a pod restart) and still only one of it.
    const firstPid = first.pid;
    process.kill(firstPid, "SIGTERM");
    assert.ok(
      await waitFor(() => readRecords(recordPath).length >= 2 && processesRunning(cli).length === 1, {
        timeoutMs: 20000,
      }),
      "the supervisor must relaunch the CLI, keeping exactly one process",
    );
    assert.notEqual(readRecords(recordPath).at(-1).pid, firstPid);
    assert.ok(service.healthSnapshot().upstream.restarts >= 1);
  } finally {
    await service.stop();
  }
  assert.equal(
    await waitFor(() => processesRunning(cli).length === 0, { timeoutMs: 10000 }),
    true,
    "stopping the service must leave no CLI behind",
  );
});

test("1.2 upstream argv never asks for a shared browser context", () => {
  const argv = upstreamArgs({ configPath: "/tmp/c.json", port: 9311, outputRoot: "/data/ws" });
  assert.deepEqual(argv, [
    "--config",
    "/tmp/c.json",
    "--host",
    "127.0.0.1",
    "--allowed-hosts",
    "127.0.0.1:9311",
    "--port",
    "9311",
    "--isolated",
    "--allow-unrestricted-file-access",
    "--output-dir",
    "/data/ws",
  ]);
  assert.equal(argv.includes("--shared-browser-context"), false);
});

test("2.4 an unreachable shared endpoint spawns nothing and reports why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-lane-dead-"));
  const deadPort = await freePort(); // reserved then released: nothing listens there
  const service = createBrowserLaneService({
    env: {
      ...process.env,
      BROWSER_SHARED_PORT: String(await freePort()),
      BROWSER_SHARED_UPSTREAM_URL: `http://127.0.0.1:${deadPort}`,
      BROWSER_SHARED_OUTPUT_ROOT: join(dir, "output"),
    },
    identifyCell: () => ({ cellId: null, reason: "test" }),
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await service.start();
    const health = service.healthSnapshot();
    assert.equal(health.upstream.mode, "attach");
    assert.equal(health.upstream.pid, null, "attach mode never spawns a playwright process");
    assert.equal(health.upstream.reachable, false, "the health face must say the lane is down");
    assert.equal(
      processesRunning("@playwright/mcp/cli.js").length,
      0,
      "no per-cell playwright may appear when the shared endpoint is down",
    );
    // The frontend still answers, so a cell fails fast with a clear reason
    // instead of hanging — and never falls back to a local browser.
    const res = await fetch(`http://127.0.0.1:${service.port}/healthz`);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    await service.stop();
  }
});

test("2.4 a session cannot be opened while the upstream is down (degrade, not fallback)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-lane-dead-"));
  const deadPort = await freePort();
  const port = await freePort();
  const service = createBrowserLaneService({
    env: {
      ...process.env,
      BROWSER_SHARED_PORT: String(port),
      BROWSER_SHARED_UPSTREAM_URL: `http://127.0.0.1:${deadPort}`,
      BROWSER_SHARED_OUTPUT_ROOT: join(dir, "output"),
    },
    identifyCell: () => ({ cellId: null, reason: "test" }),
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await service.start();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    assert.ok(res.status >= 400, `initialize against a dead upstream must fail (got ${res.status})`);
    assert.equal(service.sessions.size, 0, "no half-open session is left behind");
  } finally {
    await service.stop();
  }
});
