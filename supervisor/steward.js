// ── Steward: the resident supervisor host (add-cell-lifecycle, chapter 1) ──
//
// Wraps a Supervisor (the SAME Electron-agnostic class) with a loopback-only
// control plane, so the runtime stack can outlive any UI session:
//
//   socket    macOS/Linux: <dataDir>/steward.sock   (owner-only by dataDir ACL)
//             Windows:     \\.\pipe\yizuo-steward-<sha256(dataDir)[:16]>
//   protocol  JSON-lines:  request  {id, op, protocolVersion, params?}
//                          response {id, protocolVersion, ok, result?|error?}
//   discovery <dataDir>/steward.json — socket path, protocolVersion, pid,
//             startedAt. Written 0600 after the socket listens.
//
// A request whose protocolVersion major is unsupported is REFUSED with an
// explicit version error (spec: never a silent misparse). Ops are deliberately
// small: status / start / stop / drainQuit / getPolicy / setPolicy. The policy
// engine (always|on_demand) plugs in via registerPolicyEngine; the steward
// itself owns no scheduling decisions beyond draining.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STEWARD_PROTOCOL_VERSION } from "../lib/cell-lifecycle.js";
import { newRegistryRow, createJsonRegistry, migrateRegistryRow } from "../lib/cell-registry.js";
import { createKeyStorage, pairSteward } from "./steward-identity.js";
import { createStewardReporter, readPairFile } from "./steward-reporter.js";

export function stewardSocketTarget(dataDir) {
  if (process.platform === "win32") {
    const key = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\yizuo-steward-${key}`;
  }
  return path.join(dataDir, "steward.sock");
}

const OPS = new Set(["hello", "status", "start", "stop", "drainQuit", "getPolicy", "setPolicy", "restart", "pair", "unpair", "pairStatus"]);

export function createSteward({ supervisor, dataDir, policyEngine: initialEngine = null, onExit = (code) => process.exit(code) } = {}) {
  const socketTarget = stewardSocketTarget(dataDir);
  const discoveryFile = path.join(dataDir, "steward.json");
  const registry = createJsonRegistry({ file: path.join(dataDir, "steward-registry.json") });
  registry.load();
  // The desktop cell's own registry row (one steward = one cell). Identity is
  // the data root; pairing/device identity rides in chapter 3.
  const cellId = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  if (!registry.get(cellId)) {
    registry.put(newRegistryRow({ cellId, ownerEmail: null, policy: "always" }));
  }

  let server = null;
  let running = false;
  let policy = loadPolicy();
  let policyEngine = initialEngine;

  // ── Uplink client (add-cell-lifecycle 4.3) ────────────────────────────────
  // Only exists after an explicit pair (pair file = opt-in proof). Manifest
  // stitches fleet numbers from the cell's own persisted stores — read-only,
  // never touching the runtime.
  let reporter = null;
  function manifestFnFactory() {
    return () => readBeaconManifest(dataDir);
  }
  function startReporter() {
    if (reporter) reporter.stop();
    const storage = createKeyStorage({ cellId, dataDir });
    reporter = createStewardReporter({ steward: stewardApi, dataDir, storage, appVersion: process.env.APP_VERSION ?? null, manifestFn: manifestFnFactory() });
    reporter.start();
  }
  async function stopReporter() {
    reporter?.stop();
    reporter = null;
  }

  function loadPolicy() {
    try {
      const row = migrateRegistryRow(registry.get(cellId) ?? {});
      return row?.row?.policy ?? "always";
    } catch { return "always"; }
  }
  function savePolicy(next) {
    const row = registry.get(cellId) ?? newRegistryRow({ cellId });
    registry.put({ ...row, policy: next });
    policy = next;
  }

  function discover() {
    try {
      return JSON.parse(fs.readFileSync(discoveryFile, "utf8"));
    } catch { return null; }
  }

  function handle(op, params, send) {
    switch (op) {
      case "hello":
        return send({ protocolVersion: STEWARD_PROTOCOL_VERSION, pid: process.pid });
      case "status":
        return send({ state: running ? "running" : "stopped", policy, servers: supervisor.status(), steward: discover() });
      case "start":
        return void (async () => {
          try {
            if (!running) { await supervisor.start(); running = true; }
            send({ started: true, already: false });
          } catch (e) { send({ error: e.message }); }
        })();
      case "stop":
        return void (async () => {
          await supervisor.stop().catch(() => {});
          running = false;
          send({ stopped: true });
        })();
      case "drainQuit":
        return void (async () => {
          await supervisor.stop().catch(() => {});
          running = false;
          try { fs.rmSync(discoveryFile, { force: true }); } catch { /* best-effort */ }
          try { fs.rmSync(path.join(dataDir, "steward.pid"), { force: true }); } catch { /* best-effort */ }
          send({ stopped: true, quitting: true });
          setTimeout(() => onExit(0), 25);
        })();
      case "restart":
        return void (async () => {
          try { send({ restarted: await supervisor.restart(params.id) }); }
          catch (e) { send({ error: e.message }); }
        })();
      case "pair": {
        // Explicit-opt-in action (add-cell-lifecycle 4.1/4.3): entering a
        // bind code IS the uplink consent — pairing starts the reporter.
        return void (async () => {
          try {
            const storage = createKeyStorage({ cellId, dataDir });
            const gatewayUrl = (process.env.STEWARD_GATEWAY_URL || "https://platform.finddatatech.cloud").replace(/\/+$/, "");
            const deviceId = cellId;
            const r = await pairSteward({ gatewayUrl, code: params.code, deviceId, label: params.label ?? null, storage });
            if (!r.ok) return send({ error: r.error ?? "pair failed" });
            fs.writeFileSync(
              path.join(dataDir, "steward-pair.json"),
              JSON.stringify({ token: r.token, email: r.email ?? null, deviceId, gatewayUrl }, null, 2),
              { mode: 0o600 },
            );
            startReporter();
            send({ paired: true, deviceId, email: r.email ?? null });
          } catch (e) { send({ error: e?.message || String(e) }); }
        })();
      }
      case "unpair":
        return void (async () => {
          await stopReporter().catch(() => {});
          try {
            const storage = createKeyStorage({ cellId, dataDir });
            await storage.remove();
          } catch { /* */ }
          try { fs.rmSync(path.join(dataDir, "steward-pair.json"), { force: true }); } catch { /* */ }
          send({ unpaired: true });
        })();
      case "pairStatus": {
        const pf = readPairFile(dataDir);
        return send({ paired: Boolean(pf?.token), deviceId: pf?.deviceId ?? null, gatewayUrl: pf?.gatewayUrl ?? null, email: pf?.email ?? null });
      }
      case "getPolicy":
        return send({ policy });
      case "setPolicy": {
        const next = params?.policy;
        if (!["always", "on_demand", "manual"].includes(next)) return send({ error: `unknown policy: ${next}` });
        savePolicy(next);
        policyEngine?.reload?.(next);
        return send({ policy: next });
      }
      default:
        return send({ error: `unknown op: ${op}` });
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = net.createServer((conn) => {
        let buf = "";
        conn.on("data", (chunk) => {
          buf += chunk;
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg = null;
            try { msg = JSON.parse(line); } catch { /* malformed frame → drop line */ }
            if (!msg) continue;
            policyEngine?.noteActivity?.();
            const reply = (part) =>
              conn.write(JSON.stringify({ id: msg.id ?? null, protocolVersion: STEWARD_PROTOCOL_VERSION, ok: !part?.error, ...part }) + "\n");
            const requestedMajor = Number(msg.protocolVersion);
            if (!Number.isFinite(requestedMajor) || Math.trunc(requestedMajor) !== STEWARD_PROTOCOL_VERSION) {
              reply({ error: `unsupported protocolVersion ${msg.protocolVersion} (server speaks ${STEWARD_PROTOCOL_VERSION})` });
              continue;
            }
            if (!OPS.has(msg.op)) {
              reply({ error: `unknown op: ${msg.op}` });
              continue;
            }
            handle(msg.op, msg.params ?? {}, reply);
          }
        });
      });
      server.once("error", reject);
      server.listen(socketTarget, () => {
        fs.writeFileSync(
          discoveryFile,
          JSON.stringify({ socket: socketTarget, protocolVersion: STEWARD_PROTOCOL_VERSION, pid: process.pid, startedAt: Date.now(), dataDir }, null, 2),
          { mode: 0o600 },
        );
        // Plain-pid twin: the NSIS installer drains by pid WITHOUT parsing
        // JSON in NSIS macro language (fragile) — numbers only, one line.
        fs.writeFileSync(path.join(dataDir, "steward.pid"), String(process.pid), { mode: 0o600 });
        resolve({ socket: socketTarget, protocolVersion: STEWARD_PROTOCOL_VERSION, pid: process.pid });
      });
    });
  }

  async function shutdown({ removeDiscovery = false } = {}) {
    if (removeDiscovery) { try { fs.rmSync(discoveryFile, { force: true }); } catch { /* best-effort */ } }
    await supervisor.stop().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  }

  const stewardApi = {
    start,
    shutdown,
    socket: socketTarget,
    discoveryFile,
    cellId,
    registry,
    get policy() { return policy; },
    get running() { return running; },
    set running(v) { running = v; },
    setPolicyEngine(engine) { policyEngine = engine; },
    startReporter,
    stopReporter,
  };
  // Uplink self-start: a pair file left by an earlier boot is the still-valid
  // opt-in; reporter starts quietly beside the stack (degrade-open).
  if (readPairFile(dataDir)?.token) startReporter();
  return stewardApi;
}

// Manifest gatherer (add-cell-lifecycle 4.3): fleet facts from the cell's own
// persisted stores — sqlite read-only, never via the runtime.
import { DatabaseSync } from "node:sqlite";
import { readCronJobs, cellJobsFile } from "../lib/cell-lifecycle.js";

function readBeaconManifest(dataDir) {
  const jobs = readCronJobs(cellJobsFile(dataDir));
  const out = {
    fleetCount: 0,
    memberCount: 0,
    enabledTaskCount: jobs.filter((j) => j?.cron && !j?.paused).length,
    labels: [],
  };
  try {
    const db = new DatabaseSync(`file:${path.join(dataDir, "data", "data", "fleets.db")}?mode=ro`, { readOnly: true });
    const fleets = db.prepare("SELECT id, name FROM fleets").all();
    out.fleetCount = fleets.length;
    out.labels = fleets.map((f) => f.name).filter(Boolean).slice(0, 32);
    for (const f of fleets) {
      out.memberCount += db.prepare("SELECT COUNT(*) AS n FROM members WHERE fleet_id = ?").get(f.id)?.n ?? 0;
    }
    db.close();
  } catch { /* no fleet store — counters read honestly as job-count-only */ }
  return out;
}
