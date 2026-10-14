#!/usr/bin/env node
// ── Cell workspace/cwd spawn contract (migrate-fd-prod-cells, tasks 2.1–2.2) ─
//
// Boots the REAL cell registry against an env-dumping stub, so the spawn
// contract is proven without a full server boot:
//   - AGENT_WORKSPACE is per-cell, under the user's own root
//   - the process cwd is the user's per-user runtime dir (the boot chain's
//     cwd fallback tier therefore stays inside the per-user root — together
//     with resolveBootWorkspace's "invalid pin falls back loudly" unit in
//     test-workspace-boot.mjs this is the rejected-pin containment argument)
//   - an inherited gateway-level AGENT_WORKSPACE never merges two cells onto
//     one directory
//
//   node --test scripts/test-cell-workspace.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// The stub listens (so waitForPort accepts) and dumps the spawn facts under its
// own per-user root, derived from PLATFORM_DATA_DIR — no shared file to race on.
const STUB = `
import http from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const dir = path.dirname(process.env.PLATFORM_DATA_DIR);
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "spawn-dump.json"), JSON.stringify({
  cwd: process.cwd(),
  agentWorkspace: process.env.AGENT_WORKSPACE || null,
  platformDataDir: process.env.PLATFORM_DATA_DIR,
  mcpConfigPath: process.env.MCP_CONFIG_PATH || null,
}));
http.createServer((req, res) => res.end("ok")).listen(process.env.PORT, "127.0.0.1");
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readDump(root, email) {
  const file = path.join(root, userIdFor(email), "spawn-dump.json");
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`spawn dump never appeared for ${email}: ${file}`);
}

test("cells get a per-user workspace, per-user cwd, and ignore an inherited pin", async () => {
  // realpath: macOS tmpdir hands back /var/... while a spawned process's cwd
  // resolves to /private/var/... — normalize once so both sides compare
  // like-for-like (same discipline as test-workspace-boot.mjs).
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-workspace-")));
  const stub = path.join(root, "stub-cell.mjs");
  await writeFile(stub, STUB);

  const registry = createCellRegistry({
    dataRoot: path.join(root, "cells"),
    secret: "test-secret",
    startTimeoutMs: 15_000,
    idleReapSecs: 0,
    serverEntry: stub,
    // The hostile inheritance: a gateway-level pin that must NOT reach any
    // cell as its workspace.
    env: { ...process.env, AGENT_WORKSPACE: path.join(root, "inherited-must-lose") },
  });

  try {
    const A = "alice@cell-workspace.test";
    const B = "bob@cell-workspace.test";
    await registry.ensure({ email: A, groups: [] });
    await registry.ensure({ email: B, groups: [] });

    const a = await readDump(path.join(root, "cells"), A);
    const b = await readDump(path.join(root, "cells"), B);

    // Per-cell workspace under the user's own root, exactly what the spawner
    // pinned (raw join on both sides — no realpath involved in the env value).
    const rootA = path.join(root, "cells", userIdFor(A));
    const rootB = path.join(root, "cells", userIdFor(B));
    assert.equal(a.agentWorkspace, path.join(rootA, "workspace"));
    assert.equal(b.agentWorkspace, path.join(rootB, "workspace"));

    // The inherited pin loses (spec: inherited environment cannot merge
    // workspaces).
    assert.notEqual(a.agentWorkspace, path.join(root, "inherited-must-lose"));
    assert.notEqual(b.agentWorkspace, path.join(root, "inherited-must-lose"));

    // Two cells never share a workspace: distinct, neither an ancestor of the
    // other.
    assert.notEqual(a.agentWorkspace, b.agentWorkspace);
    assert.ok(!a.agentWorkspace.startsWith(b.agentWorkspace + path.sep));
    assert.ok(!b.agentWorkspace.startsWith(a.agentWorkspace + path.sep));

    // Per-user cwd: the boot chain's terminal fallback tier lands inside the
    // user's own root, never on a cross-cell shared directory.
    assert.equal(a.cwd, path.join(rootA, "runtime"));
    assert.equal(b.cwd, path.join(rootB, "runtime"));

    // Data root sanity while we hold the dump.
    assert.equal(a.platformDataDir, path.join(rootA, "data"));
    assert.equal(b.platformDataDir, path.join(rootB, "data"));
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

// ── The operator MCP baseline must reach cells (2026-10-10 fd-prod gap) ─────
//
// spawner used to point every cell at <cell root>/mcp.json, which nothing
// creates — so the operator baseline (mcp.json: the connector row) was
// invisible to writeMcpPatch and never landed in any dsh profile. The cell
// path now falls back to the shared baseline; a cell-private override, when
// an operator drops one in, still wins.
test("cells read the shared operator mcp.json unless a cell-private override exists", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-mcp-path-")));
  const stub = path.join(root, "stub-cell.mjs");
  await writeFile(stub, STUB);

  const dataRoot = path.join(root, "cells");
  const registry = createCellRegistry({
    dataRoot,
    secret: "test-secret",
    startTimeoutMs: 15_000,
    idleReapSecs: 0,
    serverEntry: stub,
    env: { ...process.env },
  });

  try {
    const A = "carol@cell-mcp.test";
    const B = "dave@cell-mcp.test";
    await registry.ensure({ email: A, groups: [] });
    await registry.ensure({ email: B, groups: [] });

    // B carries a cell-private override placed before its spawn.
    const bRoot = path.join(dataRoot, userIdFor(B));
    await mkdir(bRoot, { recursive: true });
    await writeFile(path.join(bRoot, "mcp.json"), JSON.stringify({ mcpServers: { override: { command: "true" } } }));
    registry.stop(userIdFor(B));
    await sleep(300);
    await registry.ensure({ email: B, groups: [] });

    const a = await readDump(dataRoot, A);
    const b = await readDump(dataRoot, B);

    // A: no cell-private file ⇒ the shared baseline (the repo/image mcp.json).
    assert.ok(a.mcpConfigPath, "cell A got an MCP_CONFIG_PATH");
    assert.equal(a.mcpConfigPath, path.join(REPO, "mcp.json"), "cell A reads the shared operator baseline");
    // B: private file present ⇒ it wins.
    assert.equal(b.mcpConfigPath, path.join(bRoot, "mcp.json"), "cell-private mcp.json overrides the baseline");
  } finally {
    await registry.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
