// A throwaway server whose model answers after a fixed delay. Several specs
// need a deterministically LONG turn (the shared e2e webServer points
// LLM_BASE_URL at an unreachable address, so its turns fail instantly and a
// queue/running state is never observable).
//
// Usage:
//   const h = await startSlowServer({ delayMs: 8000, env: { ... } });
//   ... h.base ...
//   await h.stop();
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnTestServer } from "./helpers.js";
import { startChaosLlm } from "./chaos-llm.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startSlowServer({ delayMs = 8000, env = {}, readyTimeoutMs = 180_000 } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slow-server-"));
  const llm = await startChaosLlm({ port: 0 });
  await llm.control({ mode: "slow", delayMs });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let bootLog = "";
  const server = spawnTestServer({
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AUTH_MODE: "none",
      AGENTS_CONFIG_URL: "",
      CATALOG_REFRESH_SECS: "0",
      LLM_API_KEY: "sk-e2e-dummy-key",
      LLM_BASE_URL: llm.url,
      CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
      DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
      SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
      LLM_PROVIDERS_STORE: path.join(tmpRoot, "llm-providers.json"),
      LLM_DEFAULT_STORE: path.join(tmpRoot, "llm-default.json"),
      DB_PATH: path.join(tmpRoot, "app.db"),
      MCP_CONFIG_PATH: path.join(tmpRoot, "mcp.json"),
      PLATFORM_DATA_DIR: path.join(tmpRoot, "root"),
      DSH_HOME: path.join(tmpRoot, "dsh-home"),
      DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      // Stated explicitly so a future default flip cannot silently change what
      // these specs prove.
      TURN_DISPATCH: "queue",
      ...env,
    },
  });
  server.child.stdout?.on("data", (d) => (bootLog += d));
  server.child.stderr?.on("data", (d) => (bootLog += d));

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/ready`)).ok) break;
    } catch {
      /* still booting */
    }
    if (Date.now() > deadline) {
      await server.stop();
      await llm.close();
      throw new Error(`slow test server never became ready\n${bootLog.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    base,
    llm,
    server,
    tmpRoot,
    bootLog: () => bootLog,
    async stop() {
      await server.stop();
      await llm.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

// Read the per-session turn status over a throwaway WS. Used to gate specs on a
// genuinely idle runtime (a probe's socket closing does NOT stop the turn it
// started).
export async function readTurnStatuses(base) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/");
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* already closed */ }
      resolve(value);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "list_sessions" }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "sessions") return;
      finish((msg.sessions ?? []).map((s) => ({ id: s.id, turnStatus: s.turnStatus ?? null })));
    };
    ws.onerror = () => finish([]);
    setTimeout(() => finish([]), 5000);
  });
}

export async function waitForRuntimeIdle(base, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await readTurnStatuses(base);
    if (statuses.length > 0 && statuses.every((s) => s.turnStatus === null)) return;
    if (Date.now() > deadline) throw new Error("runtime stayed busy");
    await new Promise((r) => setTimeout(r, 500));
  }
}
