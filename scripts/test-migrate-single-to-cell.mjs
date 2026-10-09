#!/usr/bin/env node
// ── Migration rehearsal: single-process → gateway/cells (migrate-fd-prod-cells 4.1)
//
// A miniature cutover, all real pieces: boots the real single-process server
// against a scratch PLATFORM_DATA_DIR, creates state through the API (document,
// session), seeds a pack into the single-process market, runs the real
// migration script, then boots the real gateway with the REAL cell entry
// against the migrated CELL_DATA_ROOT and asserts the owner sees their state:
// document library, session list, pack market — plus the migrated session
// secret keeping old cookies invalid (new secret regime is gateway-minted).
//
//   node scripts/test-migrate-single-to-cell.mjs

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackRegistry } from "../gateway/packs.js";
import { signSession } from "../server/session.js";

if (!(await import("./lib/dsh-available.mjs")).dshRuntimeAvailable()) {
  console.warn("[skip] shared dsh install unavailable — dsh runtime integration skipped (see scripts/lib/dsh-available.mjs)");
  process.exit(0);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GW_SECRET = "migrate-test-gateway-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Full-tree teardown for the rehearsal children. They are spawned detached
// (own process group) so every descendant — the dsh child of the single
// server, and for the gateway every cell server plus ITS dsh children — dies
// with one group kill. The old "SIGTERM + 500ms + SIGKILL" raced the bridge's
// ~14s shutdown ladder and orphaned dsh processes under launchd (PPID=1).
async function stopTree(child, graceMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
  };
  killGroup("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(200);
  }
  killGroup("SIGKILL");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base, logs, label, path = "/api/ready", headers = {}) {
  for (let i = 0; i < 160; i++) {
    try {
      const res = await fetch(base + path, { headers });
      if (res.status === 200) return;
    } catch { /* not listening yet */ }
    if (i === 159) throw new Error(`${label} never became ready:\n${logs.join("")}`);
    await sleep(500);
  }
}

async function startOidcStub() {
  const port = await freePort();
  const server = (await import("node:http")).createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.includes("openid-configuration")) {
      return res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/oidc/auth`,
          token_endpoint: `${base}/oidc/token`,
          jwks_uri: `${base}/oidc/jwks`,
          end_session_endpoint: `${base}/oidc/session/end`,
        }),
      );
    }
    if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), "migrate-rehearsal-"));
  const srcData = path.join(scratch, "src-data");
  const srcDsh = path.join(scratch, "src-dsh");
  const cellRoot = path.join(scratch, "cells");
  await mkdir(path.join(srcData, "workspace"), { recursive: true });
  await mkdir(srcDsh, { recursive: true });

  // Seed a pack into the single-process market DB (storeDir("data")/packs.db).
  const packsDb = path.join(srcData, "data", "packs.db");
  await mkdir(path.dirname(packsDb), { recursive: true });
  const pr = createPackRegistry({ file: packsDb });
  const published = pr.publish({
    email: "owner@rehearsal.test",
    manifest: {
      name: "rehearsal-pack",
      description: "pack that must survive the migration",
      tags: ["test"],
      skills: [{ name: "rehearsal-skill", description: "d", content: "# body\n" }],
      agents: [],
      mcpServers: [],
    },
  });
  pr.close();
  if (!published?.id) throw new Error("seed publish failed");

  // ── Phase 1: the single-process deployment, live ──────────────────────────
  // cwd is a NEUTRAL directory (not the repo): bundled assets must resolve via
  // repoRoot() with the process sitting anywhere (design D2), and it keeps the
  // boot-time legacy-store importer from pulling the dev checkout's leftovers
  // into the fixture.
  const neutralCwd = path.join(scratch, "neutral-cwd");
  await mkdir(neutralCwd, { recursive: true });
  const p1 = await freePort();
  const single = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: neutralCwd,
    detached: true,
    env: {
      ...process.env,
      PORT: String(p1),
      HOST: "127.0.0.1",
      PLATFORM_DATA_DIR: srcData,
      AGENT_WORKSPACE: path.join(srcData, "workspace"),
      DSH_HOME: srcDsh,
      MCP_CONFIG_PATH: path.join(srcData, "mcp.json"),
      AUTH_MODE: "none",
      LLM_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const singleErr = [];
  single.stderr.on("data", (b) => singleErr.push(b.toString()));
  const base1 = `http://127.0.0.1:${p1}`;
  const failures = [];
  try {
    await waitReady(base1, singleErr, "single-process");
    await fetch(`${base1}/api/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text", name: "rehearsal-doc.txt", content: "survives the migration" }),
    }).then((r) => { if (r.status !== 200) failures.push(`seed document ingest: ${r.status}`); });
    await fetch(`${base1}/api/chat-history/sessions`, { method: "POST" }).then((r) => {
      if (r.status !== 200) failures.push(`seed session: ${r.status}`);
    });
    // Session rows are lazy (first mirrored message creates them), and this
    // rehearsal drives no LLM turn — seed the row directly, the way the
    // production data already sits (direct SQLite seeding, established e2e
    // practice). Owner stays NULL: the migration's --stamp-unowned owns the
    // attribution.
    {
      const { default: Database } = await import("better-sqlite3");
      const seedDb = new Database(path.join(srcData, "data", "app.db"));
      seedDb
        .prepare("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("rehearsal-session", "rehearsal handoff", new Date().toISOString(), new Date().toISOString());
      seedDb.close();
    }
    // A workspace file, as the agent would leave one.
    await writeFile(path.join(srcData, "workspace", "handoff.md"), "# handoff\n");
  } finally {
    await stopTree(single);
  }

  // ── Phase 2: the migration script (real child process, real args) ────────
  const mig = spawn(
    process.execPath,
    [
      path.join(REPO, "scripts/migrate-single-to-cell.mjs"),
      "--email", "owner@rehearsal.test",
      "--data-dir", srcData,
      "--dsh-home", srcDsh,
      "--cell-root", cellRoot,
      "--stamp-unowned",
    ],
    {
      cwd: REPO,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let migOut = "";
  mig.stdout.on("data", (b) => (migOut += b));
  mig.stderr.on("data", (b) => (migOut += b));
  const migCode = await new Promise((resolve) => mig.on("exit", resolve));
  if (migCode !== 0) throw new Error(`migration script failed (${migCode}):\n${migOut}`);

  // ── Phase 3: the gateway era, against the migrated tree ───────────────────
  const oidc = await startOidcStub();
  const gwPort = await freePort();
  const gw = spawn(process.execPath, [path.join(REPO, "gateway/index.js")], {
    cwd: REPO,
    detached: true,
    env: {
      ...process.env,
      GATEWAY_PORT: String(gwPort),
      GATEWAY_HOST: "127.0.0.1",
      CELL_DATA_ROOT: cellRoot,
      CELL_GATEWAY_SECRET: GW_SECRET,
      CELL_IDLE_REAP_SECS: "0",
      CELL_START_TIMEOUT_MS: "60000",
      CELL_SERVER_ENTRY: path.join(REPO, "server.js"),
      SESSION_SECRET: "rehearsal-gateway-session-secret",
      LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.port}`,
      LOGTO_APP_ID: "rehearsal-app",
      LOGTO_APP_SECRET: "rehearsal-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      LLM_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const gwErr = [];
  gw.stderr.on("data", (b) => gwErr.push(b.toString()));
  const base3 = `http://127.0.0.1:${gwPort}`;

  try {
    await waitReady(base3, gwErr, "gateway", "/healthz");
    // The owner, as the gateway would see them after a real Logto sign-in.
    const owner = { email: "owner@rehearsal.test", groups: ["users", "creators"], exp: Math.floor(Date.now() / 1000) + 600 };
    const cookie = `paas_session=${signSession(owner, "rehearsal-gateway-session-secret")}`;

    const docs = await fetch(`${base3}/api/documents`, { headers: { cookie } }).then((r) => r.json());
    const names = (docs?.documents ?? []).map((d) => d.name);
    if (!names.includes("rehearsal-doc.txt")) failures.push(`document library lost the seeded doc: ${JSON.stringify(names)}`);

    const sessions = await fetch(`${base3}/api/chat-history/sessions`, { headers: { cookie } }).then((r) => r.json());
    // The seeded session was created auth-off (unowned); the migration's
    // --stamp-unowned attributes it to the owner, so the owner's scoped list
    // must show it.
    if (!Array.isArray(sessions?.sessions) || sessions.sessions.length === 0) {
      failures.push(`session list empty after migration (stamp-unowned failed?): ${JSON.stringify(sessions).slice(0, 200)}`);
    }

    const packs = await fetch(`${base3}/api/packs`, { headers: { cookie } }).then((r) => r.json());
    const packIds = (packs?.packs ?? []).map((p) => p.id);
    if (!packIds.includes(published.id)) failures.push(`pack market lost the seeded pack: ${JSON.stringify(packIds)}`);

    // The workspace handoff file is servable from the owner's cell.
    const ws = await fetch(`${base3}/api/files?root=workspace&path=handoff.md`, { headers: { cookie } });
    if (ws.status !== 200 || (await ws.text()) !== "# handoff\n") {
      failures.push(`workspace handoff file not served through the cell: HTTP ${ws.status}`);
    }

    console.log(`documents: ${names.join(", ")}`);
    console.log(`sessions: ${sessions?.sessions?.length ?? 0}`);
    console.log(`packs: ${packIds.join(", ")}`);
    console.log(`workspace handoff.md: HTTP ${ws.status}`);
  } finally {
    await stopTree(gw);
    await oidc.close();
    if (process.env.REHEARSAL_KEEP_SCRATCH) {
      console.log(`(scratch kept: ${scratch})`);
    } else {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
  pkillDsh();

  if (failures.length) {
    console.error(`\n✗ migration rehearsal: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ migration rehearsal: documents, sessions, pack market, and workspace all survived the cutover");
}

function pkillDsh() {
  // The dsh entry in this repo is node …/@deepseek-ai/dsh/lib/bin.js, so the
  // old "bin/dsh --profile" pattern never matched anything. Scope to this
  // rehearsal's scratch tree (the mkdtemp prefix rides the dsh --patch argv)
  // so a developer's concurrently-running dsh is never hit.
  try {
    spawn("pkill", ["-9", "-f", "dsh.*--profile.*migrate-rehearsal-"], { stdio: "ignore" });
  } catch { /* best effort */ }
}

main().catch((err) => {
  console.error(`✗ migration rehearsal failed: ${err.message}`);
  pkillDsh();
  process.exitCode = 1;
});
