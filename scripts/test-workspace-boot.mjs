// Unit tests for workspace boot resolution + persistence (fix-agent-workspace).
// Covers the spec scenarios:
//   - validateWorkspace: read-only directory rejected naming writability;
//     writable passes; prior validations (relative/missing/file/symlink)
//     unchanged
//   - resolveBootWorkspace: env pin wins over the persisted preference; the
//     preference restores when no pin is set; an invalid pin falls back down
//     the chain with a rejection naming the value; nothing set → process.cwd()
//   - switchWorkspaceTo: success persists workspace.current; the failed-switch
//     restore path persists the restored directory; an equal-path no-op heals
//     a missing row
//
// Run: node --test scripts/test-workspace-boot.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-boot-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const { createAppContext } = await import("../server/context.js");
const {
  attachAgentSession,
  validateWorkspace,
  resolveBootWorkspace,
  WORKSPACE_CURRENT_KEY,
} = await import("../server/agent-session.js");

await db.initDb();

const ctx = createAppContext({});
attachAgentSession(ctx);

// realpathSync at creation: macOS tmpdir hands back /var/... while realpath
// (used by the validator) returns /private/var/... — normalizing the fixtures
// keeps every comparison like-for-like.
const writableDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "writable-")));
const otherWritable = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "other-")));
const readOnlyDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "readonly-")));
fs.chmodSync(readOnlyDir, 0o500);

test.after(() => {
  fs.chmodSync(readOnlyDir, 0o700);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── validateWorkspace ────────────────────────────────────────────────────────

test("writable directory passes", async () => {
  const v = await validateWorkspace(writableDir);
  assert.equal(v.ok, true);
  assert.equal(v.path, await fs.promises.realpath(writableDir));
});

test("read-only directory is rejected naming writability", async () => {
  const v = await validateWorkspace(readOnlyDir);
  assert.equal(v.ok, false);
  assert.match(v.error, /not writable/);
  assert.ok(v.error.includes(readOnlyDir), "reason names the directory");
});

test("relative path is rejected (unchanged)", async () => {
  const v = await validateWorkspace("./src");
  assert.equal(v.ok, false);
  assert.match(v.error, /absolute/);
});

test("nonexistent path is rejected (unchanged)", async () => {
  const v = await validateWorkspace(path.join(tmpRoot, "nope"));
  assert.equal(v.ok, false);
  assert.match(v.error, /No such directory/);
});

test("file path is rejected (unchanged)", async () => {
  const file = path.join(tmpRoot, "a-file");
  fs.writeFileSync(file, "x");
  const v = await validateWorkspace(file);
  assert.equal(v.ok, false);
  assert.match(v.error, /Not a directory/);
});

test("symlink resolves to the writable target", async () => {
  const link = path.join(tmpRoot, "link-to-writable");
  fs.symlinkSync(writableDir, link);
  const v = await validateWorkspace(link);
  assert.equal(v.ok, true);
  assert.equal(v.path, await fs.promises.realpath(writableDir));
});

// ── resolveBootWorkspace ─────────────────────────────────────────────────────

const getPreference = (k) => db.getPreference(k);

test("env pin wins over the persisted preference", async () => {
  db.setPreference(WORKSPACE_CURRENT_KEY, otherWritable);
  const r = await resolveBootWorkspace({
    env: { AGENT_WORKSPACE: writableDir },
    getPreference,
  });
  assert.equal(r.source, "env");
  assert.equal(r.path, await fs.promises.realpath(writableDir));
  assert.deepEqual(r.rejected, []);
});

test("persisted current is restored when no pin is set", async () => {
  db.setPreference(WORKSPACE_CURRENT_KEY, otherWritable);
  const r = await resolveBootWorkspace({ env: {}, getPreference });
  assert.equal(r.source, "preference");
  assert.equal(r.path, await fs.promises.realpath(otherWritable));
});

test("invalid pin falls back loudly", async () => {
  db.setPreference(WORKSPACE_CURRENT_KEY, otherWritable);
  const r = await resolveBootWorkspace({
    env: { AGENT_WORKSPACE: readOnlyDir },
    getPreference,
  });
  assert.equal(r.source, "preference");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /AGENT_WORKSPACE/);
  assert.match(r.rejected[0], /not writable/);
});

test("nothing set resolves to process.cwd()", async () => {
  db.setPreference(WORKSPACE_CURRENT_KEY, "");
  const r = await resolveBootWorkspace({ env: {}, getPreference });
  assert.equal(r.source, "cwd");
  assert.equal(r.path, process.cwd());
  assert.deepEqual(r.rejected, []);
});

test("no preference reader (db unavailable) skips the preference tier", async () => {
  const r = await resolveBootWorkspace({ env: {} });
  assert.equal(r.source, "cwd");
});

// ── switchWorkspaceTo persistence ────────────────────────────────────────────

function makeBridge(cwd) {
  return {
    liveCwd: cwd,
    restarts: [],
    getCwd() {
      return this.liveCwd;
    },
    async restart(opts = {}) {
      this.restarts.push(opts);
      if (opts.cwd !== undefined) this.liveCwd = opts.cwd;
    },
  };
}

beforeEach(() => {
  broadcasts.length = 0;
});
const broadcasts = [];
ctx.broadcast = (m) => broadcasts.push(m);

test("successful switch persists workspace.current", async () => {
  ctx.dshBridge = makeBridge(writableDir);
  const r = await ctx.switchWorkspaceTo(otherWritable);
  assert.equal(r.ok, true);
  assert.equal(db.getPreference(WORKSPACE_CURRENT_KEY), await fs.promises.realpath(otherWritable));
  assert.deepEqual(
    broadcasts.filter((m) => m.type === "workspace_changed").map((m) => m.path),
    [await fs.promises.realpath(otherWritable)],
  );
});

test("equal-path no-op heals a missing current row", async () => {
  ctx.dshBridge = makeBridge(writableDir);
  db.setPreference(WORKSPACE_CURRENT_KEY, "");
  const r = await ctx.switchWorkspaceTo(writableDir);
  assert.equal(r.ok, true);
  assert.equal(ctx.dshBridge.restarts.length, 0);
  assert.equal(db.getPreference(WORKSPACE_CURRENT_KEY), await fs.promises.realpath(writableDir));
});

test("read-only switch target is rejected without a restart", async () => {
  ctx.dshBridge = makeBridge(writableDir);
  db.setPreference(WORKSPACE_CURRENT_KEY, writableDir);
  const r = await ctx.switchWorkspaceTo(readOnlyDir);
  assert.equal(r.ok, false);
  assert.match(r.error, /not writable/);
  assert.equal(ctx.dshBridge.restarts.length, 0);
  assert.equal(db.getPreference(WORKSPACE_CURRENT_KEY), await fs.promises.realpath(writableDir));
});

test("failed restart restores and persists the previous workspace", async () => {
  const failing = makeBridge(writableDir);
  const realRestart = failing.restart;
  failing.restart = async (opts = {}) => {
    if (opts.cwd !== undefined && opts.cwd === await fs.promises.realpath(otherWritable)) {
      // The target is writable (validation passes) but the spawn fails —
      // the only way to reach the restore branch now that read-only targets
      // are rejected up front.
      throw new Error("spawn failed");
    }
    return realRestart.call(failing, opts);
  };
  ctx.dshBridge = failing;
  db.setPreference(WORKSPACE_CURRENT_KEY, writableDir);
  const r = await ctx.switchWorkspaceTo(otherWritable);
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn failed/);
  // restore restart carried the previous cwd, and the preference follows it
  assert.deepEqual(failing.restarts.map((o) => o.cwd).slice(-1), [writableDir]);
  assert.equal(db.getPreference(WORKSPACE_CURRENT_KEY), writableDir);
});
