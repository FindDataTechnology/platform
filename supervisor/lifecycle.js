// ── Supervisor: process orchestration ───────────────────────────────────────
//
// Owns the lifecycle of all backend servers (spec requirements: ordered
// startup with dependency readiness, health checking per transport, automatic
// restart on unexpected failure, ordered shutdown, status inspection, log
// capture, graceful degradation of optional servers, port management).
//
// This is the shared, Electron-agnostic supervisor primitive. The desktop
// Electron app constructs it with bundle-resolved nodeBin/projectRoot/dataDir
// and opens a BrowserWindow once server-js is healthy; the headless
// `local-services` launcher (dev `npm start`) constructs it the same way but
// pins server-js to a fixed port and opens no window. One implementation,
// two entry points - no duplicated lifecycle code.

import { findFreePort } from "./ports.js";
import { getDescriptors } from "./descriptors.js";
import { spawnServer, stopChild } from "./process.js";
import { httpProbe } from "./health.js";
import { LogStore } from "./logs.js";

const HEALTH_POLL_MS = 3000; // ongoing probe interval
const START_PROBE_MS = 500; // probe interval while waiting for a fresh start
const START_TIMEOUT_MS = 120000; // how long to wait for a server to go green (server.js cold-start - MCP/provider/agent init before listen - can take ~50s)
const RESTART_BACKOFFS = [1000, 2000, 5000, 10000, 15000];

export class Supervisor {
  constructor({ nodeBin, projectRoot, dataDir, agentEnv = {}, serverPort = null }) {
    this.nodeBin = nodeBin;
    this.projectRoot = projectRoot;
    this.dataDir = dataDir || "";
    this.agentEnv = agentEnv;
    // When set (dev launcher), server-js is pinned to this port instead of a
    // free port, so the Vite dev proxy (:5173 -> :3000) and the WS client
    // (ws://localhost:3000) keep working. Null -> findFreePort.
    this.fixedServerPort = serverPort;
    this.servers = new Map(); // id -> state object
    this.logs = new LogStore();
    this.shuttingDown = false;
    this.healthTimer = null;
    this.serverPort = null;
  }

  async start() {
    if (this.serverPort) throw new Error("Supervisor has already been started");
    this.serverPort = this.fixedServerPort || (await findFreePort("127.0.0.1"));
    if (this.fixedServerPort && !(await this._portIsFree(this.serverPort))) {
      throw new Error(`fixed server port ${this.serverPort} is already in use`);
    }
    const descriptors = getDescriptors({
      serverPort: this.serverPort,
      projectRoot: this.projectRoot,
      nodeBin: this.nodeBin,
      dataDir: this.dataDir,
      agentEnv: this.agentEnv,
    });
    for (const d of descriptors) {
      this.servers.set(d.id, {
        descriptor: d,
        state: "pending",
        pid: null,
        port: d.transport === "http-port" && d.id === "server-js" ? this.serverPort : null,
        restartCount: 0,
        lastCheck: null,
        lastError: null,
        child: null,
      });
    }

    // Ongoing health polling for all enabled servers.
    this.healthTimer = setInterval(() => this._pollAll(), HEALTH_POLL_MS);

    // Start servers in dependency order. server-js is non-optional and awaited;
    // http-external/disabled entries are probed/marked here. Optional failures
    // are non-fatal.
    for (const id of this._startupOrder()) {
      const s = this.servers.get(id);
      const d = s.descriptor;
      if (!d.enabled) { s.state = "disabled"; continue; }
      if (d.kind === "http-external") {
        s.state = "starting";
        this._pollOne(id); // fire-and-forget immediate probe
        continue;
      }
      try {
        await this._startServer(id);
      } catch (err) {
        if (d.optional) {
          s.state = "unhealthy";
          s.lastError = err.message;
          this.logs.push(id, "stderr", `optional server failed to start: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }

  _startupOrder() {
    const order = [];
    const visited = new Set();
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const s = this.servers.get(id);
      for (const dep of s?.descriptor.dependsOn || []) visit(dep);
      order.push(id);
    };
    for (const id of this.servers.keys()) visit(id);
    return order;
  }

  async _portIsFree(port) {
    const net = await import("node:net");
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
  }

  async _startServer(id) {
    const s = this.servers.get(id);
    const d = s.descriptor;
    s.state = "starting";
    s.lastError = null;
    const child = spawnServer(d, {
      onLog: (stream, text) => this.logs.push(id, stream, text),
      onExit: (code, signal) => this._onExit(id, code, signal),
    });
    s.child = child;
    s.pid = child?.pid ?? null;
    // ponytail: port already set at construction (lines 68–72); skip reassignment.

    if (d.transport === "http-port" && d.url) {
      const ok = await this._waitForHealthy(id, START_TIMEOUT_MS);
      if (!ok) {
        s.state = "unhealthy";
        s.lastError = "did not become healthy within timeout";
        throw new Error(`server ${id} did not become healthy`);
      }
    }
    s.state = "healthy";
    s.lastCheck = Date.now();
  }

  async _waitForHealthy(id, timeoutMs) {
    const s = this.servers.get(id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.shuttingDown) return false;
      if (s.child && s.child.exitCode !== null) return false; // died during start
      if (await this._probeHealth(s)) { s.lastCheck = Date.now(); return true; }
      await sleep(START_PROBE_MS);
    }
    return false;
  }

  async _probeHealth(s) {
    const d = s.descriptor;
    if (!d.url) return false;
    return httpProbe(d.url + (d.healthPath || ""));
  }

  _onExit(id, code, signal) {
    const s = this.servers.get(id);
    if (!s) return;
    this.logs.push(id, "stderr", `process exited (code=${code} signal=${signal})`);
    if (this.shuttingDown || s.state === "stopped") { s.state = "stopped"; return; }
    // Unexpected exit -> restart with backoff (spec: automatic restart on failure).
    const delay = RESTART_BACKOFFS[Math.min(s.restartCount, RESTART_BACKOFFS.length - 1)];
    s.state = "unhealthy";
    s.lastError = `exited (code=${code} signal=${signal}); restarting in ${delay}ms`;
    s.restartCount += 1;
    s.child = null;
    setTimeout(() => {
      if (this.shuttingDown) return;
      this._startServer(id).catch((e) => {
        const cur = this.servers.get(id);
        if (cur) cur.lastError = `restart failed: ${e.message}`;
      });
    }, delay);
  }

  async _pollOne(id) {
    const s = this.servers.get(id);
    const d = s.descriptor;
    if (s.state === "stopped" || s.state === "disabled" || !d.url) return;
    // Spawned servers are only HTTP-polled once healthy (liveness otherwise via exit).
    if (d.kind !== "http-external" && s.state !== "healthy") return;
    const ok = await this._probeHealth(s);
    s.lastCheck = Date.now();
    if (ok) { s.state = "healthy"; s.lastError = null; }
    else { s.state = "unhealthy"; s.lastError = "health check failed"; }
  }

  _pollAll() {
    for (const id of this.servers.keys()) this._pollOne(id);
  }

  // Resolve when `id` is healthy (used by main.js for the optional external
  // services; server-js is awaited inside start()).
  waitForHealthy(id, timeoutMs = START_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const s = this.servers.get(id);
      if (!s) return reject(new Error(`unknown server ${id}`));
      if (s.state === "healthy") return resolve();
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const cur = this.servers.get(id);
        if (!cur) return reject(new Error(`unknown server ${id}`));
        if (cur.state === "healthy") return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${id}`));
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  async stop() {
    this.shuttingDown = true;
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    this.serverPort = null;
    // Stop spawned servers in reverse startup order (spec: ordered shutdown).
    for (const id of [...this._startupOrder()].reverse()) {
      const s = this.servers.get(id);
      if (s.child) {
        s.state = "stopped";
        await stopChild(s.child, 5000);
        s.child = null;
      }
    }
  }

  /**
   * Restart a single server by id (used by Preferences UI).
   * - For http-external: just re-probe health, no process stop.
   * - For spawned: stop the child, wait, then start fresh.
   * @param {string} id server id
   * @returns {Promise<boolean>} true if restart succeeded
   */
  async restart(id) {
    const s = this.servers.get(id);
    if (!s) return false;

    if (s.descriptor.kind === "http-external") {
      await this._waitForHealthy(id, 30000);
      return s.state === "healthy";
    }

    // Spawned: stop then restart
    if (s.child) {
      s.state = "stopped";
      await stopChild(s.child, 5000);
      s.child = null;
    }

    try {
      await this._startServer(id);
      return s.state === "healthy";
    } catch {
      return false;
    }
  }

  status() {
    return [...this.servers.values()].map((s) => ({
      id: s.descriptor.id,
      name: s.descriptor.name,
      kind: s.descriptor.kind,
      state: s.state,
      pid: s.pid,
      port: s.port,
      url: s.descriptor.url,
      optional: s.descriptor.optional,
      restartCount: s.restartCount,
      lastCheck: s.lastCheck,
      lastError: s.lastError,
      logs: this.logs.lines(s.descriptor.id).slice(-20),
    }));
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
