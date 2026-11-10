import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { spawnTestServer } from "./helpers.js";

// Workspace boot resolution + persistence (fix-agent-workspace), driven over
// one private server restarted across the matrix (the branding.spec.js
// spawn pattern): the persisted current workspace survives a restart, the
// AGENT_WORKSPACE pin outranks it, an invalid pin falls back loudly, and a
// read-only target is rejected at switch time naming writability.

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 180_000, label = "condition") {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-workspace-boot-e2e-"));
// realpathSync so comparisons match the validator's resolved form (macOS
// /var vs /private/var).
const wsA = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-a-")));
const wsB = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-b-")));
const wsRo = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-ro-")));
fs.chmodSync(wsRo, 0o555);

test.afterAll(() => {
  fs.chmodSync(wsRo, 0o755);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// One server generation: hermetic env (branding.spec.js minus the auth
// fixture — auth-off keeps the WS ungated), temp stores, one DSH_HOME shared
// by every generation of this spec the way a real restart shares one home.
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnTestServer({
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AGENTS_CONFIG_URL: "",
      CATALOG_REFRESH_SECS: "0",
      LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
      LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:9/v1",
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
      ...extraEnv,
    },
  });
  const child = server.child;
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/api/ready`)).ok;
      } catch {
        return false;
      }
    },
    150_000,
    `server ready\n${log.slice(-2000)}`,
  );
  return { child, base, log: () => log, stop: (opts) => server.stop(opts) };
}

// Raw WS request/reply against the spawned server (Node's global WebSocket).
function wsRoundtrip(base, message, want) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/");
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`ws timeout waiting for ${want}`));
    }, 30_000);
    let sent = false;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!sent) {
        // Skip the connect-time sync burst before sending.
        if (msg.type !== "sessions" && msg.type !== "workspaces") return;
        ws.send(JSON.stringify(message));
        sent = true;
        return;
      }
      if (msg.type === "error" && sent) {
        clearTimeout(timer);
        ws.close();
        reject(new Error(msg.message));
      }
      if (msg.type === want) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    };
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message}`));
  });
}

test.describe("workspace boot resolution + persistence", () => {
  test.describe.configure({ mode: "serial", timeout: 400_000 });

  test("read-only switch rejected naming writability; switch persists", async () => {
    const srv = await startServer();
    try {
      // Read-only target: rejected up front, no restart, current unchanged.
      const roErr = await wsRoundtrip(srv.base, { type: "set_workspace", path: wsRo }, "error").catch(
        (e) => e,
      );
      expect(String(roErr.message)).toMatch(/not writable/);
      const afterRo = await wsRoundtrip(srv.base, { type: "list_workspaces" }, "workspaces");
      expect(afterRo.current).not.toBe(wsRo);

      // Writable switch: applied + broadcast.
      const changed = await wsRoundtrip(srv.base, { type: "set_workspace", path: wsA }, "workspace_changed");
      expect(changed.path).toBe(wsA);
      const listed = await wsRoundtrip(srv.base, { type: "list_workspaces" }, "workspaces");
      expect(listed.current).toBe(wsA);
      expect(listed.recents).toContain(wsA);
    } finally {
      await srv.stop();
    }
  });

  test("current workspace survives a server restart", async () => {
    const srv = await startServer();
    try {
      const listed = await wsRoundtrip(srv.base, { type: "list_workspaces" }, "workspaces");
      expect(listed.current).toBe(wsA);
    } finally {
      await srv.stop();
    }
  });

  test("AGENT_WORKSPACE pin outranks the persisted preference", async () => {
    const srv = await startServer({ AGENT_WORKSPACE: wsB });
    try {
      const listed = await wsRoundtrip(srv.base, { type: "list_workspaces" }, "workspaces");
      expect(listed.current).toBe(wsB);
      // The boot log names the resolution source.
      expect(srv.log()).toMatch(new RegExp(`\\[workspace\\] boot workspace: .* \\(source=env\\)`));
    } finally {
      await srv.stop();
    }
  });

  test("invalid pin falls back loudly to the persisted preference", async () => {
    const srv = await startServer({ AGENT_WORKSPACE: wsRo });
    try {
      const listed = await wsRoundtrip(srv.base, { type: "list_workspaces" }, "workspaces");
      // The read-only pin was rejected; the persisted ws-A is restored.
      expect(listed.current).toBe(wsA);
      expect(srv.log()).toMatch(/\[workspace\] AGENT_WORKSPACE .* not writable/);
    } finally {
      await srv.stop();
    }
  });
});
