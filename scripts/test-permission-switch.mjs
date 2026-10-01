// Unit tests for the permission preset switch guards (add-permission-mode-
// selector). Runs switchPermissionTo against a stub bridge, covering the
// scenarios the specs call out:
//   - streaming guard: rejected while a turn is in flight
//   - unknown preset name → error, state unchanged
//   - empty roster (no permission service composed) → error
//   - happy path: bridge called, currentPermission updated, broadcast sent
//
// Run: node --test scripts/test-permission-switch.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "permission-switch-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const { createAppContext } = await import("../server/context.js");
const { attachAgentSession } = await import("../server/agent-session.js");

await db.initDb();

const ctx = createAppContext({});
attachAgentSession(ctx);

const ROSTER = {
  options: [
    { name: "read-only", label: "Read only", description: "" },
    { name: "workspace-write", label: "Workspace write", description: "" },
    { name: "danger-full-access", label: "Full access", description: "" },
  ],
  current: "workspace-write",
};

// Stub bridge factory: records set calls, replays the roster, optional
// failure modes. Built fresh per test — a spread would carry an overridden
// listPermissionPresets from a previous test into the next one.
function makeBridge(overrides = {}) {
  return {
    ready: true,
    failList: null,
    failSet: null,
    sets: [],
    isReady() { return this.ready; },
    async listPermissionPresets() {
      if (this.failList) throw new Error(this.failList);
      return { ...ROSTER, current: ctx.currentPermission ?? ROSTER.current };
    },
    async setPermissionPreset(sessionId, name) {
      if (this.failSet) throw new Error(this.failSet);
      this.sets.push({ sessionId, name });
      return { current: name };
    },
    ...overrides,
  };
}

beforeEach(() => {
  ctx.dshBridge = makeBridge();
  ctx.currentPermission = "workspace-write";
  ctx.isStreaming = false;
  ctx.broadcast = () => {};
});

test("happy path: switch calls the bridge, updates state, broadcasts", async () => {
  const bridge = makeBridge();
  ctx.dshBridge = bridge;
  const seen = [];
  ctx.broadcast = (m) => seen.push(m);
  const r = await ctx.switchPermissionTo("read-only");
  assert.equal(r.ok, true);
  assert.deepEqual(bridge.sets, [{ sessionId: ctx.dshSessionId, name: "read-only" }]);
  assert.equal(ctx.currentPermission, "read-only");
  assert.deepEqual(seen, [{ type: "current_permission", name: "read-only" }]);
});

test("switching to the effective preset is a no-op", async () => {
  const bridge = makeBridge();
  ctx.dshBridge = bridge;
  const r = await ctx.switchPermissionTo("workspace-write");
  assert.equal(r.ok, true);
  assert.equal(bridge.sets.length, 0);
});

test("rejected while streaming", async () => {
  const bridge = makeBridge();
  ctx.dshBridge = bridge;
  ctx.isStreaming = true;
  const r = await ctx.switchPermissionTo("read-only");
  assert.equal(r.ok, false);
  assert.match(r.error, /responding/i);
  assert.equal(bridge.sets.length, 0);
  assert.equal(ctx.currentPermission, "workspace-write");
});

test("unknown preset name is rejected with the state unchanged", async () => {
  const bridge = makeBridge();
  ctx.dshBridge = bridge;
  const r = await ctx.switchPermissionTo("yolo");
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown permission mode: yolo/);
  assert.equal(bridge.sets.length, 0);
  assert.equal(ctx.currentPermission, "workspace-write");
});

test("empty roster (no composed service) is rejected", async () => {
  ctx.dshBridge = makeBridge({
    async listPermissionPresets() {
      return { options: [], current: null };
    },
  });
  const r = await ctx.switchPermissionTo("read-only");
  assert.equal(r.ok, false);
  assert.match(r.error, /No permission modes/);
});

test("a bridge failure surfaces as an error and keeps the previous preset", async () => {
  ctx.dshBridge = makeBridge({ failSet: "child died" });
  const r = await ctx.switchPermissionTo("danger-full-access");
  assert.equal(r.ok, false);
  assert.match(r.error, /child died/);
  assert.equal(ctx.currentPermission, "workspace-write");
});

test("bridge not ready → empty roster, switch rejected before the call", async () => {
  ctx.dshBridge = makeBridge({ ready: false });
  const r = await ctx.switchPermissionTo("read-only");
  assert.equal(r.ok, false);
  assert.equal(ctx.dshBridge.sets.length, 0);
});
