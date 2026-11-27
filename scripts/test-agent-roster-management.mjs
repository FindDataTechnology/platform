// Unit tests for the agent-roster management plane (add-agent-roster-management
// tasks 1.1–1.3): the hidden-role preference, its catalog projection, and the
// one thing that must NOT follow it — dispatch resolution.
//
// The whole point of this capability is that "I don't want to see this role"
// is a VIEW preference, not a disappearance:
//   - it stores catalog ids (the roster form folds case/punctuation, and a
//     fold collision would hide the wrong role);
//   - it is an idempotent complete-list overwrite, so multi-tab/retry converges;
//   - it filters the requester-facing catalog ONLY — the unfiltered chat-agent
//     roster that cron/fleet posts resolve against is untouched. Breaking that
//     turns a hidden post into `Unknown agent preset` at fire time (the
//     2026-11-14 shape, server/fleet-target-runnable.js).
//
// Run: node --test scripts/test-agent-roster-management.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roster-mgmt-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
// No cloud catalog, no registry: the merged catalog is exactly what this test
// seeds (built-in local + one custom preset) — a stray live source would make
// the "byte-identical for the rest" assertion flaky.
delete process.env.AGENTS_CONFIG_URL;

let db;
let catalog;

before(async () => {
  db = await import("../db.js");
  await db.initDb();
  catalog = await import("../catalog.js");
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("hidden set: store → read round-trips, de-duplicates, keeps catalog ids verbatim", () => {
  db.setHiddenAgents(["pack-a.Role-1", "pack-a.Role-1", "user.x"]);
  assert.deepEqual(db.getHiddenAgents(), ["pack-a.Role-1", "user.x"]);
});

test("hidden set: an empty list CLEARS the preference (never a stored [])", () => {
  db.setHiddenAgents(["pack-a.Role-1"]);
  db.setHiddenAgents([]);
  assert.deepEqual(db.getHiddenAgents(), []);
  assert.equal(db.getPreference("catalog.hiddenAgents"), null, "key is deleted, not stored as []");
});

test("hidden set: a corrupt stored value reads as none (inert, self-healing)", () => {
  db.setPreference("catalog.hiddenAgents", "{not json");
  assert.deepEqual(db.getHiddenAgents(), []);
});

test("catalog: hidden entries leave the requester view, the rest are byte-identical", async () => {
  const preset = db.createUserPreset({ name: "Roster Test Role", persona: "p", skills: [], mcpServers: [] });
  const before = catalog.getCatalogFor(null);
  const beforeById = new Map(before.agents.map((a) => [a.id, JSON.stringify(a)]));

  db.setHiddenAgents([preset.id]);
  const after = catalog.getCatalogFor(null);
  const afterById = new Map(after.agents.map((a) => [a.id, JSON.stringify(a)]));

  assert.equal(afterById.has(preset.id), false, "the hidden role is gone");
  assert.equal(after.agents.length, before.agents.length - 1);
  for (const [id, json] of beforeById) {
    if (id === preset.id) continue;
    assert.equal(afterById.get(id), json, `every other entry is byte-identical (${id})`);
  }

  // Unhide restores it, same shape.
  db.setHiddenAgents([]);
  const restored = new Map(catalog.getCatalogFor(null).agents.map((a) => [a.id, JSON.stringify(a)]));
  assert.equal(restored.get(preset.id), beforeById.get(preset.id));

  db.deleteUserPreset(preset.id);
});

test("catalog: the built-in local agent is never hideable by the projection", async () => {
  db.setHiddenAgents(["local"]);
  const ids = catalog.getCatalogFor(null).agents.map((a) => a.id);
  assert.ok(ids.includes("local"), "local survives a hidden-set naming it — it is the runtime carrier, not a partner");
  db.setHiddenAgents([]);
});

test("dispatch: the unfiltered chat roster still carries a hidden role", async () => {
  const preset = db.createUserPreset({ name: "Dispatch Test Role", persona: "p", skills: [], mcpServers: [] });
  db.setHiddenAgents([preset.id]);

  const chatIds = catalog.getChatAgentEntries().map((e) => e.id);
  assert.ok(chatIds.includes(preset.id), "cron/fleet resolution must still see the role it is bound to");

  const requesterIds = catalog.getCatalogFor(null).agents.map((a) => a.id);
  assert.equal(requesterIds.includes(preset.id), false, "...while the human-facing view is filtered");

  db.setHiddenAgents([]);
  db.deleteUserPreset(preset.id);
});

test("catalog: a departed id in the hidden set matches nothing and breaks nothing", async () => {
  db.setHiddenAgents(["ghost.role.that.never.existed"]);
  const agents = catalog.getCatalogFor(null).agents;
  assert.ok(agents.length > 0, "the catalog still serves");
  db.setHiddenAgents([]);
});

// ── Route layer (2.1–2.3) ────────────────────────────────────────────────────
//
// The routes are the contract's only write face. What matters:
//   - PUT takes a COMPLETE set and is idempotent (a retried/replayed write
//     lands the same state);
//   - it refuses `local` and malformed input with a named reason, leaving the
//     stored set untouched;
//   - GET /api/agent/usage is scoped to the requester, while the ops per-pack
//     aggregate keeps its own gate and grouping (two口径, one table).

test("routes: PUT /api/agent/hidden is idempotent and refuses the built-in agent", async () => {
  const express = (await import("express")).default;
  const { registerAgentRosterRoutes } = await import("../server/routes/agent-roster.js");

  const app = express();
  app.use(express.json());
  const broadcasts = [];
  registerAgentRosterRoutes({ app, broadcast: (m) => broadcasts.push(m), authEnabled: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (hidden) =>
    fetch(`${base}/api/agent/hidden`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden }),
    });

  try {
    const ok = await put(["pack-a.one", "pack-a.one", "pack-b.two"]);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).hidden, ["pack-a.one", "pack-b.two"]);
    assert.equal(broadcasts.at(-1)?.type, "catalog_changed");

    const again = await put(["pack-a.one", "pack-b.two"]);
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).hidden, ["pack-a.one", "pack-b.two"], "replay converges");

    const local = await put(["local"]);
    assert.equal(local.status, 400);
    assert.deepEqual(db.getHiddenAgents(), ["pack-a.one", "pack-b.two"], "a refused write leaves the set untouched");

    const bad = await put([1, ""]);
    assert.equal(bad.status, 400);

    const cleared = await put([]);
    assert.deepEqual((await cleared.json()).hidden, []);
    assert.equal(db.getPreference("catalog.hiddenAgents"), null);

    const read = await fetch(`${base}/api/agent/hidden`).then((r) => r.json());
    assert.deepEqual(read.hidden, []);
  } finally {
    server.close();
  }
});

test("routes: usage is scoped to the requester, same rows as the ops aggregate", async () => {
  const { getDb } = await import("../db.js");
  const telemetry = await import("../server/usage-telemetry.js");
  const now = Date.now();
  const ins = getDb().prepare(
    `INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(now, "alice@x", "s1", "pack-a.role", "pack-a", "ok", 1);
  ins.run(now, "alice@x", "s1", "pack-a.role", "pack-a", "ok", 1);
  ins.run(now, "bob@x", "s2", "pack-b.role", "pack-b", "ok", 1);

  const alice = telemetry.agentUsageAggregate({ days: 7, ownerEmail: "alice@x" });
  assert.equal(alice.rows.length, 1);
  assert.equal(alice.rows[0].agentId, "pack-a.role");
  assert.equal(alice.rows[0].turns, 2);
  assert.ok(alice.rows[0].lastUsedAt > 0);

  const all = telemetry.agentUsageAggregate({ days: 7, ownerEmail: null });
  assert.equal(all.rows.length, 2, "auth-off requester is the machine owner — reads everything");

  // Same rows, same window: the per-pack total and the per-agent total agree.
  const perPack = telemetry.packUsageAggregate(7);
  const packTurns = perPack.rows.reduce((n, r) => n + r.turns, 0);
  const agentTurns = all.rows.reduce((n, r) => n + r.turns, 0);
  assert.equal(agentTurns, packTurns, "both aggregations count the same rows");
});
// ── The picker's preset payload (real-machine defect, 2026-11-25) ────────────
//
// Hiding a role removes its agent row; the picker drops a preset only while an
// agent row represents it — so its GENERATED dsh preset resurfaced as a
// composition row ("采集位 来自智能体「官网内容团队」"). The fix filters the
// human-facing `presets` payload, which must:
//   - drop presets whose roster id belongs to a hidden role,
//   - keep the current preset (else the header label degrades to a raw id),
//   - leave getAgentPresets/the dispatch roster untouched.
// This pins the filter's shape; the wiring is a one-liner in ws.js list_presets.

test("picker preset filter: hidden role's generated preset is dropped, live preset kept", async () => {
  const dshProfile = await import("../dsh-profile.js");
  const rosterOf = (id) => dshProfile.rosterPresetId(id);
  const presets = [
    { id: "standard", name: "Standard" },
    { id: rosterOf("web-scout"), name: "采集位" },
    { id: rosterOf("web-writer"), name: "合成位" },
  ];
  const hidden = new Set(["web-scout"]);
  const current = "standard";
  const visible = presets.filter(
    (p) => p.id === current || !new Set([...hidden].map(rosterOf)).has(p.id),
  );
  assert.deepEqual(visible.map((p) => p.id), ["standard", rosterOf("web-writer")]);

  // The LIVE preset survives even when it is itself hidden — the label must
  // resolve, and hiding is a view preference, not an ejection.
  const liveHidden = presets.filter(
    (p) => p.id === rosterOf("web-scout") || !new Set(["web-scout"].map(rosterOf)).has(p.id),
  );
  assert.deepEqual(liveHidden.map((p) => p.id), presets.map((p) => p.id));
});
