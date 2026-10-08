#!/usr/bin/env node
// ── Cell writable-state containment audit (add-multi-tenant-cloud task 1.1) ──
//
// A cell may write ONLY under its two configured roots: PLATFORM_DATA_DIR and
// DSH_HOME. Anything it writes relative to its working directory would be
// shared with every other cell on the host, since the spawner runs cells from
// a common CWD (the repo) to give them the same read-only app code and skills.
//
// This boots a cell-shaped server with an EMPTY scratch CWD and exercises every
// user-facing write path, then asserts the CWD is still empty. Any CWD-relative
// write shows up as a stray entry and fails the run.
//
//   node scripts/test-cell-containment.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

if (!(await import("./lib/dsh-available.mjs")).dshRuntimeAvailable()) {
  console.warn("[skip] shared dsh install unavailable — dsh runtime integration skipped (see scripts/lib/dsh-available.mjs)");
  process.exit(0);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY = {
  "x-forwarded-email": "audit@cell.test",
  "x-forwarded-groups": "admin",
  "x-cloud-gateway-secret": "audit-secret",
};

// Read-only inputs a cell legitimately reads from its CWD (shared app code):
// linked into the scratch dir so the run matches production without making the
// scratch dir a write target by itself.
const READ_ONLY_LINKS = ["skills", "web/dist"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Every entry under `root` that is neither one of the read-only `allowed` links
// nor a directory created only to hold one of them. Symlinked dirs are not
// descended into — their contents are the repo's, not the cell's.
async function strayEntries(root, allowed) {
  const namespaces = new Set();
  for (const rel of allowed) {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) namespaces.add(parts.slice(0, i).join("/"));
  }
  const strays = [];
  const walk = async (rel) => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (namespaces.has(child)) continue;
      strays.push(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child);
    }
  };
  await walk("");
  return strays;
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), "cell-audit-"));
  const data = path.join(scratch, "data");
  const dshHome = path.join(scratch, "dsh");
  const cwd = path.join(scratch, "cwd");
  await mkdir(cwd, { recursive: true });

  const links = [];
  for (const rel of READ_ONLY_LINKS) {
    const source = path.join(REPO, rel);
    if (!existsSync(source)) continue;
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await symlink(source, path.join(cwd, rel), "dir");
    links.push(rel);
  }

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    PLATFORM_DATA_DIR: data,
    DSH_HOME: dshHome,
    MCP_CONFIG_PATH: path.join(data, "mcp.json"),
    CLOUD_MODE: "1",
    CELL_GATEWAY_SECRET: IDENTITY["x-cloud-gateway-secret"],
    AUTH_MODE: "forward_auth",
    // No provider: the cell still boots and serves REST (graceful degrade) and
    // the audit does not pay for a dsh initialize it cannot use.
    LLM_API_KEY: "",
  };

  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (c) => log.push(`[out] ${c}`));
  child.stderr.on("data", (c) => log.push(`[err] ${c}`));

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...IDENTITY, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  const failures = [];
  const exercised = [];

  try {
    // Wait for the boot to finish: /api/ready answers 503 until dsh init has
    // settled, so a 200 is the "fully booted" signal.
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        const res = await call("GET", "/api/ready");
        ready = res.status === 200;
      } catch { /* not listening yet */ }
      if (!ready) await sleep(500);
    }
    if (!ready) {
      throw new Error(`cell never became ready:\n${log.join("")}`);
    }

    // ── Exercise every write path that is reachable without an LLM ──────────
    const writes = [
      ["PUT", "/api/preferences", { key: "audit.key", value: "1" }],
      ["POST", "/api/documents", { type: "text", name: "audit.txt", content: "containment audit" }],
      ["POST", "/api/extensions/skills", { name: "audit-skill", description: "audit", content: "# audit" }],
      ["POST", "/api/extensions/mcp", { name: "audit-mcp", config: { command: "true" }, enabled: false }],
    ];
    for (const [method, route, body] of writes) {
      const res = await call(method, route, body);
      exercised.push(`${method} ${route} → ${res.status}`);
      if (res.status >= 400) failures.push(`${method} ${route} returned ${res.status}: ${res.text.slice(0, 200)}`);
    }

    // Resource save (openspec: add-resource-library): reads a workspace file
    // and writes the stored copy under the resources store in
    // PLATFORM_DATA_DIR. The source fixture is created and removed by the audit
    // itself, so it cannot mask a cell-created stray; the boot-time store-dir
    // creation is exercised by initStore regardless.
    const sourceRel = "audit-source.txt";
    await writeFile(path.join(cwd, sourceRel), "containment resource audit");
    const savedResource = await call("POST", "/api/resources", { path: sourceRel });
    exercised.push(`POST /api/resources → ${savedResource.status}`);
    if (savedResource.status >= 400) {
      failures.push(`POST /api/resources returned ${savedResource.status}: ${savedResource.text.slice(0, 200)}`);
    }
    const listedResources = await call("GET", "/api/resources");
    exercised.push(`GET /api/resources → ${listedResources.status}`);
    if (listedResources.status !== 200 || !JSON.parse(listedResources.text || "{}").total) {
      failures.push(`GET /api/resources did not show the saved resource: ${listedResources.text.slice(0, 200)}`);
    }
    await rm(path.join(cwd, sourceRel), { force: true });

    // The library is not an auth-exempt surface: the same request without the
    // cell's identity headers must be refused by the existing auth gate — no
    // new auth mechanism was introduced (openspec: add-resource-library).
    const unauthenticated = await fetch(base + "/api/resources");
    exercised.push(`GET /api/resources (no identity) → ${unauthenticated.status}`);
    if (unauthenticated.status !== 401) {
      failures.push(
        `/api/resources answered ${unauthenticated.status} without identity — it must sit behind the cell auth gate`,
      );
    }

    // Cron persistence is WebSocket-only; it writes cron-store/jobs.json.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: IDENTITY });
      const timer = setTimeout(() => reject(new Error("cron_add timed out")), 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "cron_add", cron: "0 0 1 1 *", prompt: "audit" })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "cron_added") {
          clearTimeout(timer);
          exercised.push(`WS cron_add → job ${msg.job?.id}`);
          ws.close();
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(`cron_add error: ${msg.message}`));
        }
      });
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    // Let debounced/async store writes (MCP patch settle, documents manifest)
    // land before reading the filesystem.
    await sleep(1500);

    // ── Containment assertion ───────────────────────────────────────────────
    const stray = await strayEntries(cwd, links);
    if (stray.length) {
      failures.push(`CWD-relative writes outside the data roots: ${stray.join(", ")}`);
    }

    const dataEntries = await readdir(data);
    const dshEntries = await readdir(dshHome).catch(() => []);
    console.log(`\ncell CWD (${cwd}): ${links.length ? links.map((l) => `${l} (read-only link)`).join(", ") : "(empty)"}${stray.length ? ` + STRAY: ${stray.join(", ")}` : ""}`);
    console.log(`PLATFORM_DATA_DIR: ${dataEntries.sort().join(", ") || "(empty)"}`);
    console.log(`DSH_HOME:          ${dshEntries.sort().join(", ") || "(empty)"}`);
    console.log(`\nexercised:\n  ${exercised.join("\n  ")}`);

    if (!dataEntries.length) failures.push("PLATFORM_DATA_DIR is empty — state did not land under the data root");

    if (failures.length) {
      console.error(`\n✗ containment: ${failures.length} failure(s)`);
      for (const f of failures) console.error(`  - ${f}`);
      console.error(`\nserver log:\n${log.join("")}`);
      process.exitCode = 1;
      return;
    }
    console.log("\n✓ containment: all writes landed under the cell's data roots");
  } catch (err) {
    console.error(`✗ containment audit failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
}

main();
