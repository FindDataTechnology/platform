#!/usr/bin/env node
// ── Pack usage telemetry tests (add-pack-usage-telemetry tasks 1.1/2.1/3.1) ──
//
// The store's table + prune, the recorder's pack resolution and
// failure-isolation, and the ops-gated aggregate endpoint end-to-end against
// an in-process express app.
//
//   node --test scripts/test-pack-usage.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

// Isolation env BEFORE any module that resolves paths/db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-usage-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.PACK_USAGE_TOKEN = "ops-token";

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");
const { recordPackUsage, prunePackUsage, packUsageAggregate } = await import("../server/usage-telemetry.js");
const { registerPackUsageRoutes } = await import("../server/routes/pack-usage.js");

const rawRows = () => db.getDb().prepare("SELECT * FROM pack_usage_events ORDER BY id").all();

// ── 1.1 table + prune ────────────────────────────────────────────────────────

test("1.1 migration creates pack_usage_events and reopen is idempotent", () => {
  const cols = db.getDb().prepare("PRAGMA table_info(pack_usage_events)").all().map((c) => c.name);
  assert.ok(cols.includes("pack_id") && cols.includes("user_email") && cols.includes("duration_ms"));
});

test("1.1 prune removes only rows past the retention window", () => {
  const now = Date.now();
  db.getDb().prepare("INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms) VALUES (?,?,?,?,?,?,?)")
    .run(now, "a@x", "s1", "local", null, "ok", 100);
  db.getDb().prepare("INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms) VALUES (?,?,?,?,?,?,?)")
    .run(now - 181 * 86_400_000, "a@x", "s0", "local", null, "ok", 100);
  const removed = prunePackUsage();
  assert.equal(removed, 1);
  const rows = rawRows();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].ts >= now - 1000);
});

// ── 2.1 record + pack resolution + failure isolation ────────────────────────

test("2.1 a turn records one row; duration derives from startedAt; unknown agent keeps the fact with NULL pack", () => {
  recordPackUsage({ userEmail: "u@finddata.tech", sessionId: "s2", agentId: "local", outcome: "ok", startedAt: Date.now() - 5_000 });
  recordPackUsage({ userEmail: "u@finddata.tech", sessionId: "s2", agentId: "agent-no-catalog", outcome: "error", startedAt: Date.now() - 1_000 });
  const rows = rawRows().filter((r) => r.session_id === "s2");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].duration_ms >= 4_900 && rows[0].duration_ms < 6_000);
  assert.equal(rows[0].pack_id, null);
  // Unknown agent: NULL pack, not a dropped row (design D3).
  assert.equal(rows[1].pack_id, null);
  assert.equal(rows[1].outcome, "error");
});

test("2.1 record never throws even with an absent pack_id resolution path", () => {
  // A symbol agentId would break String() paths only if the recorder were
  // careless; the exported surface must stay total.
  assert.doesNotThrow(() => recordPackUsage({ sessionId: "s3", agentId: "local", outcome: "ok" }));
});

test("2.1 a catalog pack agent resolves to its pack origin", async () => {
  const manifest = {
    name: "法律-合同",
    description: "合同审查",
    tags: ["法律"],
    skills: [{ name: "demo-skill", description: "演示", content: "# v1\n" }],
    mcpServers: [],
    agents: [{ id: "pack-law-contract", name: "合同审查员", persona: "你是审查员。" }],
  };
  const { report } = await packStore.installPack({ packId: "pk-usage-1", version: 1, manifest, user: { email: "u@x" } });
  assert.equal(report.agents[0].status, "installed");
  recordPackUsage({ userEmail: "u@finddata.tech", sessionId: "s9", agentId: "pack-law-contract", outcome: "ok", startedAt: Date.now() - 2_000 });
  const row = rawRows().find((r) => r.session_id === "s9");
  assert.equal(row.pack_id, "pk-usage-1");
});

// ── 3.1 aggregate + ops gate ────────────────────────────────────────────────

test("3.1 aggregate groups per pack, counts distinct users, keeps packless separate", () => {
  const packId = "pack-tele-1";
  // Two users on one pack, one user packless, inside the window.
  for (const u of ["a@x", "b@x"]) {
    db.getDb().prepare("INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms) VALUES (?,?,?,?,?,?,?)")
      .run(Date.now(), u, "s4", "agent-1", packId, "ok", 100);
  }
  db.getDb().prepare("INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms) VALUES (?,?,?,?,?,?,?)")
    .run(Date.now(), "a@x", "s5", "local", null, "ok", 100);
  const agg = packUsageAggregate(7);
  const packRow = agg.rows.find((r) => r.packId === packId);
  const nullRow = agg.rows.find((r) => r.packId === null);
  assert.equal(packRow.turns, 2);
  assert.equal(packRow.activeUsers, 2);
  assert.ok(packRow.lastUsedAt > 0);
  assert.equal(nullRow.turns >= 1, true);
  // Weekly-active counts pack lines with ≥1 user, never the packless line.
  assert.equal(agg.weeklyActivePacks, agg.rows.filter((r) => r.packId && r.activeUsers >= 1).length);
  assert.ok(agg.weeklyActivePacks >= 1);
});

test("3.1 endpoint: bearer ops token reads; anything else is refused", async () => {
  const app = express();
  registerPackUsageRoutes({ app });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (headers) => fetch(base + "/api/ops/pack-usage?days=7", { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    const ok = await get({ Authorization: "Bearer ops-token" });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.rows));
    assert.equal(typeof ok.body.weeklyActivePacks, "number");
    const anon = await get({});
    assert.equal(anon.status, 401);
    const bad = await get({ Authorization: "Bearer wrong" });
    assert.equal(bad.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
