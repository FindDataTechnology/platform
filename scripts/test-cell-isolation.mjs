#!/usr/bin/env node
// ── Two-cell isolation proof (add-multi-tenant-cloud task 1.3) ───────────────
//
// Broadcast scoping is meant to fall out of routing (design D7): a cell's
// `broadcast()` reaches every socket IT owns, and in hosted mode every socket a
// cell owns belongs to one user. That claim is worth proving rather than
// assuming, so this boots two cells (two users, two data roots, two ports), one
// WebSocket client each, and asserts that work done in cell A produces state
// and frames visible ONLY to A.
//
// "Two browsers" here are two real WS clients over the real WS contract; a chat
// turn would need a live LLM, so the isolated observables are the ones that
// broadcast without one — session lists, document ingest events, and errors.
//
//   node scripts/test-cell-isolation.mjs

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

async function startCell(label, identity) {
  const root = await mkdtemp(path.join(tmpdir(), `cell-${label}-`));
  const cwd = path.join(root, "cwd");
  const workspace = path.join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PLATFORM_DATA_DIR: path.join(root, "data"),
      DSH_HOME: path.join(root, "dsh"),
      MCP_CONFIG_PATH: path.join(root, "data", "mcp.json"),
      CLOUD_MODE: "1",
      CELL_GATEWAY_SECRET: identity["x-cloud-gateway-secret"],
      AUTH_MODE: "forward_auth",
      // Same shape the gateway spawner pins (migrate-fd-prod-cells): the
      // agent's produced files live under the user's own root and are served
      // from there.
      AGENT_WORKSPACE: workspace,
      LLM_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (c) => errors.push(c.toString()));

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...identity, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${base}/api/ready`, { headers: identity });
      if (res.status === 200) break;
    } catch { /* not listening yet */ }
    if (i === 119) throw new Error(`cell ${label} never became ready:\n${errors.join("")}`);
    await sleep(500);
  }

  // One browser per cell. Every frame it receives is recorded — including the
  // connect-time sync — so "user B saw nothing" is measured, not assumed.
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: identity });
  ws.on("message", (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  return { label, root, child, base, call, ws, frames };
}

async function main() {
  const secret = "isolation-secret";
  const failures = [];
  const userA = { "x-forwarded-email": "a@cell.test", "x-forwarded-groups": "users", "x-cloud-gateway-secret": secret };
  const userB = { "x-forwarded-email": "b@cell.test", "x-forwarded-groups": "users", "x-cloud-gateway-secret": secret };

  const A = await startCell("a", userA);
  let B;
  try {
    B = await startCell("b", userB);

    // Each user establishes its own state.
    await A.call("POST", "/api/documents", { type: "text", name: "a-only.txt", content: "user A secret" });
    await B.call("POST", "/api/documents", { type: "text", name: "b-only.txt", content: "user B secret" });
    await A.call("POST", "/api/chat-history/sessions");
    await B.call("POST", "/api/chat-history/sessions");
    await sleep(1000);

    // Both cells have been broadcasting (documents_status, sessions). Anything
    // B holds now is B's own; snapshot before A acts again.
    const aSeen = A.frames.length;
    const bSeen = B.frames.length;
    if (!aSeen || !bSeen) failures.push(`a cell produced no WS frames (A=${aSeen}, B=${bSeen}) — the silence check would be vacuous`);

    // ── A acts alone; B's socket must stay silent ────────────────────────────
    await A.call("POST", "/api/documents", { type: "text", name: "a-second.txt", content: "more A" });
    await A.call("POST", "/api/chat-history/sessions");
    await A.call("PUT", "/api/preferences", { key: "isolation", value: "a" });
    await sleep(1500);

    const aDelta = A.frames.slice(aSeen);
    const bDelta = B.frames.slice(bSeen);
    if (!aDelta.length) failures.push("cell A received no frames for its own writes — nothing was broadcast to check");
    if (bDelta.length) {
      failures.push(`cell B received ${bDelta.length} frame(s) caused by cell A's writes: ${JSON.stringify(bDelta).slice(0, 300)}`);
    }
    const aDocEvent = aDelta.some((f) => f.type === "documents_status");
    if (!aDocEvent) failures.push("cell A never saw its own documents_status broadcast");

    // ── State isolation, read back over REST ────────────────────────────────
    const aDocs = (await A.call("GET", "/api/documents")).body?.documents?.map((d) => d.name) ?? [];
    const bDocs = (await B.call("GET", "/api/documents")).body?.documents?.map((d) => d.name) ?? [];
    const aSessions = (await A.call("GET", "/api/chat-history/sessions")).body?.sessions ?? [];
    const bSessions = (await B.call("GET", "/api/chat-history/sessions")).body?.sessions ?? [];
    const aIds = new Set(aSessions.map((s) => s.id));
    const crossSessions = bSessions.filter((s) => aIds.has(s.id));

    if (!aDocs.includes("a-only.txt") || !aDocs.includes("a-second.txt")) failures.push(`A's library is missing its own documents: ${aDocs.join(", ")}`);
    if (aDocs.some((n) => n.startsWith("b-"))) failures.push(`A's library contains B's documents: ${aDocs.join(", ")}`);
    if (!bDocs.includes("b-only.txt") || bDocs.some((n) => n.startsWith("a-"))) failures.push(`B's library leaked: ${bDocs.join(", ")}`);
    if (crossSessions.length) failures.push(`B's session list shares ids with A's: ${crossSessions.map((s) => s.id).join(", ")}`);

    // ── Errors stay inside the cell that caused them ─────────────────────────
    const bBefore = B.frames.length;
    A.ws.send(JSON.stringify({ type: "no_such_message_type" }));
    A.ws.send("not json");
    await sleep(800);
    if (B.frames.length !== bBefore) failures.push("cell B received frames from cell A's malformed input");

    // ── Produced files stay inside the owning cell (migrate-fd-prod-cells 2.3)
    // The agent's write lands in the pinned per-user workspace; the file route
    // serves it from there for A, and the SAME relative path on B must 404 —
    // B's workspace root is a different directory, so there is nothing to
    // reach even though the route contract is identical.
    const { writeFile: putFile } = await import("node:fs/promises");
    await putFile(path.join(A.root, "workspace", "produced-report.md"), "# A 的产出\n");
    const rel = "produced-report.md";
    const aFetch = await fetch(`${A.base}/api/files?root=workspace&path=${encodeURIComponent(rel)}`, { headers: userA });
    const bFetch = await fetch(`${B.base}/api/files?root=workspace&path=${encodeURIComponent(rel)}`, { headers: userB });
    if (aFetch.status !== 200) failures.push(`A could not fetch its own workspace file: HTTP ${aFetch.status}`);
    if (aFetch.status === 200 && (await aFetch.text()) !== "# A 的产出\n") failures.push("A's workspace file served wrong bytes");
    if (bFetch.status !== 404) failures.push(`B reached A's workspace file over the same route: HTTP ${bFetch.status}`);
    // And the on-disk truth: the file lives under A's per-user root only.
    const bStray = await fetch(`${B.base}/api/files?root=workspace&path=${encodeURIComponent("../" + path.basename(A.root) + "/workspace/" + rel)}`, { headers: userB });
    if (bStray.status !== 403 && bStray.status !== 404) failures.push(`B's traversal toward A's root was not refused: HTTP ${bStray.status}`);

    console.log(`cell A: ${aDocs.length} document(s), ${aSessions.length} session(s), ${A.frames.length} WS frame(s)`);
    console.log(`cell B: ${bDocs.length} document(s), ${bSessions.length} session(s), ${B.frames.length} WS frame(s)`);
    console.log(`cell A documents: ${aDocs.join(", ")}`);
    console.log(`cell B documents: ${bDocs.join(", ")}`);
  } finally {
    for (const cell of [A, B]) {
      if (!cell) continue;
      cell.ws?.close();
      cell.child.kill("SIGTERM");
      await sleep(400);
      if (cell.child.exitCode === null) cell.child.kill("SIGKILL");
      await rm(cell.root, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (failures.length) {
    console.error(`\n✗ isolation: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ isolation: no cross-cell state, stream events, or errors");
}

main().catch((err) => {
  console.error(`✗ isolation run failed: ${err.message}`);
  process.exitCode = 1;
});
