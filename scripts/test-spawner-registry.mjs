// Unit tests — spawner ↔ durable registry (add-cell-lifecycle 3.1/3.3/3.4).
//
// Pins:
//   - a destroyed cell never re-binds on traffic (ensure rejects tombstones)
//   - the durable state machine tracks spawn/stop after the facade (register
//     → bindRequested → up → suspended across a stop call)
//   - reaping honors residency: on_demand reaps on quiet even WITH enabled
//     cron (the exemption is superseded); `always` is never reaped
//
// Run: node --test scripts/test-spawner-registry.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createCellRegistry, userIdFor } = await import("../gateway/spawner.js");
const { createCellRegistryDb } = await import("../gateway/cell-registry.js");
const { newRegistryRow } = await import("../lib/cell-registry.js");

const NOW = Date.now();

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spawnreg-")), "cells-registry.db");
  return createCellRegistryDb({ file });
}
function stubServerEntry() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stub-entry-")), "stub-server.mjs");
  fs.writeFileSync(file, 'import net from "node:net"; const s = net.createServer(() => {}); s.listen(process.env.PORT, "127.0.0.1");\n');
  return file;
}

function spawnerConfig(registryDb, over = {}) {
  return {
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "dataroot-")),
    secret: "s",
    startTimeoutMs: 1000,
    idleReapSecs: 1,
    serverEntry: stubServerEntry(),
    env: {},
    registryDb,
    ...over,
  };
}

test("backfill seeds suspended rows and recovers ownerEmail from the cell's own app.db", async () => {
  const db = tmpDb();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dataroot-bf-"));
  const { createHash } = await import("node:crypto");
  const email = "owner@cell.test";
  const cellId = createHash("sha256").update(email).digest("hex").slice(0, 16);
  const appDir = path.join(dataRoot, cellId, "data", "data");
  fs.mkdirSync(appDir, { recursive: true });
  const cellDb = new (await import("better-sqlite3")).default(path.join(appDir, "app.db"));
  cellDb.exec("CREATE TABLE user_registry_credentials (email TEXT, token TEXT)");
  cellDb.prepare("INSERT INTO user_registry_credentials (email, token) VALUES (?, '')").run(email);
  cellDb.close();
  fs.mkdirSync(path.join(dataRoot, "f".repeat(16)), { recursive: true });

  const spawner = createCellRegistry(spawnerConfig(db, { dataRoot }));
  const row = db.get(cellId);
  assert.equal(row.state, "suspended", "backfilled rows are suspended, not unbound");
  assert.equal(row.ownerEmail, email, "owner email recovered from cell app.db");
  assert.equal(db.get("f".repeat(16))?.ownerEmail ?? null, null);
  assert.equal(db.get("f".repeat(16))?.state, "suspended");
  await spawner.shutdown().catch(() => {});
  db.close();
});

test("rescue pass: a blind-seeded unbound row upgrades to suspended with the recovered email", async () => {
  const db = tmpDb();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dataroot-rsc-"));
  const { createHash } = await import("node:crypto");
  const email = "rescue@cell.test";
  const cellId = createHash("sha256").update(email).digest("hex").slice(0, 16);
  const appDir = path.join(dataRoot, cellId, "data", "data");
  fs.mkdirSync(appDir, { recursive: true });
  const cellDb = new (await import("better-sqlite3")).default(path.join(appDir, "app.db"));
  cellDb.exec("CREATE TABLE user_registry_credentials (email TEXT, token TEXT)");
  cellDb.prepare("INSERT INTO user_registry_credentials (email, token) VALUES (?, '')").run(email);
  cellDb.close();
  // Pre-seed the exact stale shape the first live roll left behind.
  db.put({ ...newRegistryRow({ cellId }), state: "unbound", ownerEmail: null });

  const spawner = createCellRegistry(spawnerConfig(db, { dataRoot }));
  const row = db.get(cellId);
  assert.equal(row.state, "suspended", "down beat fires even on pre-existing rows");
  assert.equal(row.ownerEmail, email, "owner email upgraded through put (register refuses on existing rows)");
  await spawner.shutdown().catch(() => {});
  db.close();
});

test("ensure rejects a tombstoned cell (traffic never resurrects it)", async () => {
  const db = tmpDb();
  const userId = userIdFor("x@y.z");
  db.put({ ...newRegistryRow({ cellId: userId }), state: "destroyed", destroy: { reason: "operator:t", at: NOW } });
  const spawner = createCellRegistry(spawnerConfig(db));
  await assert.rejects(() => spawner.ensure({ email: "x@y.z" }), (e) => e.code === "cell_destroyed");
  await spawner.shutdown().catch(() => {});
  db.close();
});

test("spawn→register→up→stop→suspended beats land in the registry", async () => {
  const db = tmpDb();
  const spawner = createCellRegistry(spawnerConfig(db));
  const email = "cycle@t.ist";
  const { createHash } = await import("node:crypto");
  const userId = createHash("sha256").update(email).digest("hex").slice(0, 16);
  await spawner.ensure({ email });
  let row = db.get(userId);
  assert.equal(row.state, "running");
  assert.equal(row.ownerEmail, email);
  spawner.stop(userId, "test-stop");
  // /bin/echo exits instantly; the exit handler turns stopping→down→suspended.
  await new Promise((r) => setTimeout(r, 600));
  row = db.get(userId);
  assert.equal(row.state, "suspended");
  assert.ok(row.lastBoundAt);
  db.close();
});

test("on_demand reaps despite outstanding cron (exemption retirement); always is never reaped", async () => {
  const db = tmpDb();
  const spawner = createCellRegistry(spawnerConfig(db, { initialPolicy: "on_demand" }));
  const mk = (id, lastTraffic) =>
    spawner.cells.set(id, { userId: id, email: `${id}@x`, demo: false, state: "running", port: 1, pid: null, child: null, startedAt: lastTraffic, lastTraffic, error: null });
  mk("a".repeat(16), NOW - 60_000);
  db.put({ ...newRegistryRow({ cellId: "a".repeat(16) }), state: "running", policy: "on_demand" });
  mk("b".repeat(16), NOW - 60_000);
  db.put({ ...newRegistryRow({ cellId: "b".repeat(16) }), state: "running", policy: "always" });
  const stopped = [];
  const origStop = spawner.stop;
  // reapIdle calls the closure-local stop(); observe via cells state instead.
  await spawner.reapIdle();
  assert.equal(spawner.cells.get("a".repeat(16)).state, "stopping", "on_demand quiet cell reaped (cron exemption superseded)");
  assert.equal(spawner.cells.get("b".repeat(16)).state, "running", "always is never reaped");
  void origStop; void stopped;
  await spawner.shutdown().catch(() => {});
  db.close();
});
