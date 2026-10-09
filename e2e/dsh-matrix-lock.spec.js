import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { spawnTestServer } from "./helpers.js";

// dsh install-matrix boot gate (add-dsh-matrix-lock): the gate contract is
// spec-level process behavior, so this spec spawns the real server.js with a
// synthetic matrix (tiny lock + tiny install trees — the gate reads files, it
// does not care that the packages are fake) and observes:
//   - tree deviating from the lock  → process exits 1 BEFORE the port binds,
//     stderr carries the package-level diff
//   - deviation + DSH_MATRIX_OVERRIDE=1 → boots, deviation report retained
//   - install root absent (dev machine) → boots, skip note in the log
//   - tree matching the lock → boots, match note in the log

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-matrix-gate-e2e-"));

// ── Synthetic matrix fixtures ────────────────────────────────────────────────
const LOCK = {
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
    "node_modules/@deepseek-ai/dsh-base": { version: "0.1.1-rc.2" },
    "node_modules/@deepseek-ai/cordis-plugin-hmr": { version: "1.0.16" },
  },
};

function makeTree(root, { hmrVersion = "1.0.16", includeHmr = true } = {}) {
  const mk = (scope, name, version) => {
    const dir = path.join(root, "node_modules", scope, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `${scope}/${name}`, version }));
  };
  mk("@deepseek-ai", "dsh", "0.1.1-rc.2");
  mk("@deepseek-ai", "dsh-base", "0.1.1-rc.2");
  if (includeHmr) mk("@deepseek-ai", "cordis-plugin-hmr", hmrVersion);
}

const lockPath = path.join(tmpRoot, "lock.json");
fs.writeFileSync(lockPath, JSON.stringify(LOCK));
const okTree = path.join(tmpRoot, "tree-ok");
const badTree = path.join(tmpRoot, "tree-bad"); // hmr floated to 1.0.17 (mismatch)
makeTree(okTree);
makeTree(badTree, { hmrVersion: "1.0.17" });

// ── Server spawn helper ──────────────────────────────────────────────────────
function spawnServer({ port, matrixRoot, matrixLock = lockPath, override } = {}) {
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
      DSH_MATRIX_LOCK: matrixLock,
      DSH_MATRIX_INSTALL_ROOT: matrixRoot,
      ...(override ? { DSH_MATRIX_OVERRIDE: "1" } : {}),
    },
  });
  const child = server.child;
  const out = [];
  const err = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => err.push(String(d)));
  return {
    child,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    // resolves on "Platform listening" in stdout or process exit, whichever first
    settled: () =>
      new Promise((resolve) => {
        const t = setInterval(() => {
          if (out.join("").includes("Platform listening")) {
            clearInterval(t);
            resolve("listening");
          }
        }, 100);
        child.on("exit", (code) => {
          clearInterval(t);
          resolve({ exited: code ?? null });
        });
      }),
    exited: () =>
      new Promise((resolve, reject) => {
        child.on("exit", (code) => resolve(code ?? null));
        child.on("error", reject);
      }),
    kill: (opts) => server.stop(opts),
  };
}

test.describe("dsh install-matrix boot gate", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test("tree deviating from the lock refuses to start with a package diff", async () => {
    const srv = spawnServer({ port: await freePort(), matrixRoot: badTree });
    const result = await srv.settled();
    await srv.kill();
    expect(result).not.toBe("listening");
    expect(result.exited).toBe(1);
    const stderr = srv.stderr();
    expect(stderr).toContain("refusing to start");
    expect(stderr).toContain("mismatch");
    expect(stderr).toContain("@deepseek-ai/cordis-plugin-hmr@1.0.17");
    expect(stderr).toContain("1.0.16");
  });

  test("DSH_MATRIX_OVERRIDE=1 boots despite the deviation, report retained", async () => {
    const srv = spawnServer({ port: await freePort(), matrixRoot: badTree, override: true });
    const result = await srv.settled();
    expect(result).toBe("listening");
    // the override report goes to stderr (console.warn), the boot log to stdout
    expect(srv.stderr()).toContain("DSH_MATRIX_OVERRIDE");
    expect(srv.stderr()).toContain("mismatch");
    await srv.kill();
  });

  test("no install root (dev machine) skips verification and boots", async () => {
    const srv = spawnServer({ port: await freePort(), matrixRoot: path.join(tmpRoot, "no-such-root") });
    const result = await srv.settled();
    expect(result).toBe("listening");
    expect(srv.stdout()).toContain("skipping dsh tree verification");
    await srv.kill();
  });

  test("tree matching the lock boots with the match note", async () => {
    const srv = spawnServer({ port: await freePort(), matrixRoot: okTree });
    const result = await srv.settled();
    expect(result).toBe("listening");
    expect(srv.stdout()).toContain("matches frozen matrix");
    await srv.kill();
  });
});
