// Steward resident smoke — the acts a GitHub runner CAN prove (add-cell-lifecycle
// 5.3, the automatable half of the eight-act walk-through):
//
//   act 跑    start the real entry (`supervisor/steward-main.js`) on a temp data
//             root; the control plane must come up and answer hello/status, and
//             steward.pid must agree with the discovery record
//   act 排干  `drainQuit` (what the uninstaller/LaunchAgent-less teardown asks
//             for) stops the stack, removes discovery+pid, exits 0
//   act 撤销  a platform that answers 401 twice (report + silent re-login) must
//             make the steward burn its own identity: pair file gone, sealed key
//             gone, "burning local identity" on the record — the console-revoke
//             path, end to end, through the real boot
//
// What stays human: sleep/wake and reboot survival (no CI runner can nap), and
// the attach-from-UI half — that one lives in `release.yml`'s `installer e2e
// (windows)`, where a real installer + real Platform.exe are on disk.
//
// Run: node scripts/smoke-steward-resident.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { newRegistryRow } from "../lib/cell-registry.js";
import { attachSteward, readStewardDiscovery } from "../supervisor/steward-client.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(PROJECT_ROOT, "supervisor", "steward-main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs = 30000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last.message})` : ""}`);
}

function cellIdFor(dataDir) {
  return crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
}

// A manual-policy registry row keeps the smoke about the steward, not about a
// full backend cold start (the stack boot has its own smoke: win-install-smoke B).
function seedManualPolicy(dataDir) {
  const cellId = cellIdFor(dataDir);
  fs.writeFileSync(
    path.join(dataDir, "steward-registry.json"),
    JSON.stringify([newRegistryRow({ cellId, ownerEmail: null, policy: "manual" })], null, 2),
  );
  return cellId;
}

function startSteward(dataDir, { env = {} } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PLATFORM_DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  return { child, out, text: () => out.join("") };
}

async function actResident() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-smoke-"));
  seedManualPolicy(dataDir);
  const s = startSteward(dataDir);
  try {
    const discovery = await waitFor("steward.json", () => readStewardDiscovery(dataDir));
    const attached = await attachSteward(dataDir);
    if (!attached.ok) throw new Error(`attach refused: ${attached.reason}`);

    const status = await attached.client.request("status");
    if (status.state !== "stopped") throw new Error(`manual policy must leave the stack down, got ${status.state}`);

    const pidFile = Number(fs.readFileSync(path.join(dataDir, "steward.pid"), "utf8").trim());
    if (pidFile !== discovery.pid) throw new Error(`steward.pid (${pidFile}) != discovery pid (${discovery.pid})`);
    console.log(`[smoke] act 跑 PASS — control plane up, pid ${pidFile}, policy manual`);

    const exited = new Promise((r) => s.child.once("exit", (code) => r(code)));
    await attached.client.request("drainQuit");
    const code = await Promise.race([exited, sleep(20000).then(() => "timeout")]);
    if (code !== 0) throw new Error(`drainQuit did not exit cleanly (${code})`);
    if (fs.existsSync(path.join(dataDir, "steward.json")) || fs.existsSync(path.join(dataDir, "steward.pid"))) {
      throw new Error("drainQuit left discovery/pid files behind");
    }
    console.log("[smoke] act 排干 PASS — stack stopped, discovery+pid removed, exit 0");
  } finally {
    try { s.child.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function actRevoke() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-revoke-"));
  seedManualPolicy(dataDir);
  const cellId = cellIdFor(dataDir);

  let hits = 0;
  const gateway = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Authentication required" }));
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

  // A paired steward's on-disk shape, minus a live platform: key (plaintext
  // legacy form — on Windows CI storage migrates it into DPAPI on first read,
  // exercising the seal path inside the real process) + pair file with token.
  fs.writeFileSync(path.join(dataDir, ".steward-keyv1"), crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  fs.writeFileSync(
    path.join(dataDir, "steward-pair.json"),
    JSON.stringify({ token: "stale-token", email: "smoke@example.com", deviceId: cellId, gatewayUrl }, null, 2),
    { mode: 0o600 },
  );

  const s = startSteward(dataDir);
  try {
    try {
      await waitFor("pair file burned", () => !fs.existsSync(path.join(dataDir, "steward-pair.json")), { timeoutMs: 40000 });
    } catch (e) {
      console.error(`[smoke] revoke act stalled; steward output:\n${s.text()}`);
      throw e;
    }
    if (!s.text().includes("burning local identity")) {
      throw new Error("self-destruct went through without recording itself");
    }
    for (const f of [".steward-keyv1", ".steward-keyv1.dpapi"]) {
      if (fs.existsSync(path.join(dataDir, f))) throw new Error(`key store ${f} survived the revoke`);
    }
    if (hits < 1) throw new Error("the platform door was never called — the revoke path did not run");
    console.log(`[smoke] act 撤销 PASS — ${hits} 401s answered, identity burned, reporting dark`);
  } finally {
    try { s.child.kill("SIGKILL"); } catch { /* already gone */ }
    await new Promise((r) => gateway.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await actResident();
await actRevoke();
console.log("[smoke] steward resident smoke: ALL ACTS PASS");
