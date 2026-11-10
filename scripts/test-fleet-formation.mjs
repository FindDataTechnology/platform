// add-teams-hub-formation-board 1.1/1.2: the overview payload carries a compact
// per-fleet `formation` summary (nodes + declared edges with read-time
// supervisor expansion), fetched in ONE round-trip — the hub's formation grid
// never walks per-fleet detail endpoints (N+1 ban, fix-session-open-latency
// precedent). `truncated` flags teams over the node cap (1.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-formation-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

test.after(() => {
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const fleetDb = createFleetDatabase({
  file: path.join(tmpRoot, `fleets-${Date.now()}.db`),
});
setFleetDatabase(fleetDb);

function makeFleet(name) {
  return fleetDb.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: "owner@test" });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { email: "owner@test", groups: [] };
    next();
  });
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: () => ({ alive: false, label: "" }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p) => fetch(`${base}${p}`, { headers: { "x-test-user": "owner@test" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

test("overview carries per-fleet formation: nodes, declared+implicit edges, one round-trip", async () => {
  const f1 = makeFleet("小队");
  const f2 = makeFleet("空队");
  fleetDb.createMember({ id: "m1", fleetId: f1.id, title: "巡线岗", parentId: null, targetKind: "persona", targetId: "persona-a", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "m2", fleetId: f1.id, title: "纪要岗", parentId: null, targetKind: "persona", targetId: "persona-b", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "m3", fleetId: f1.id, title: "写作岗", parentId: "m1", targetKind: "persona", targetId: "persona-c", kpiSlots: [], cadence: null });
  // Declared handoff edge + supervisor mode (read-time implicit dispatch).
  fleetDb.updateFleet(f1.id, {
    orchestration: { mode: "supervisor", edges: [{ kind: "handoff", from: "m2", to: "m3" }] },
  });

  const { server, call } = await startServer();
  try {
    const r = await call("/api/fleets/overview");
    assert.equal(r.status, 200);
    const rows = r.body.fleets;
    // ONE payload for ALL fleets — the hub fetches once, never per-fleet.
    assert.equal(rows.length, 2);
    const small = rows.find((x) => x.id === f1.id);
    const empty = rows.find((x) => x.id === f2.id);

    assert.equal(small.formation.truncated, false);
    assert.deepEqual(
      small.formation.members.map((m) => m.id),
      ["m1", "m2", "m3"],
      "nodes are the member roster (id/title/kind/status)",
    );
    assert.ok(small.formation.members[0].title && "status" in small.formation.members[0]);
    const kinds = small.formation.edges.map((e) => e.kind);
    assert.ok(kinds.includes("handoff"), "declared edge present");
    assert.ok(kinds.filter((k) => k === "dispatch").length >= 2, "supervisor mode expands implicit dispatch edges");
    assert.ok(small.formation.edges.every((e) => "implicit" in e), "implicit edges are marked");

    // A fleet without orchestration renders nodes with an empty edge list.
    assert.deepEqual(empty.formation.edges, []);
    assert.equal(empty.formation.truncated, false);
  } finally {
    server.close();
  }
});

test("a team over the node cap reports truncated (1.2)", async () => {
  const big = makeFleet("巨阵");
  for (let i = 0; i < 26; i++) {
    fleetDb.createMember({ id: `b${i}`, fleetId: big.id, title: `岗${i}`, parentId: null, targetKind: "persona", targetId: `persona-${i}`, kpiSlots: [], cadence: null });
  }
  const { server, call } = await startServer();
  try {
    const r = await call("/api/fleets/overview");
    const row = r.body.fleets.find((x) => x.id === big.id);
    assert.equal(row.formation.truncated, true, "26 nodes > cap 24 → thumbnail signal");
    assert.equal(row.formation.members.length, 26, "nodes still listed; the CLIENT decides how to render");
  } finally {
    server.close();
  }
});

// 3.1: the hub copilot focus resolves honestly — no architect installed
// answers { copilot: null } (the dock opens unfocused instead of pretending).
test("fleets copilot focus: no architect installed → null (honest degrade)", async () => {
  const { server, call } = await startServer();
  try {
    const r = await call("/api/fleets/copilot");
    assert.equal(r.status, 200);
    assert.equal(r.body.line, "fleets");
    assert.equal(r.body.copilot, null);
  } finally {
    server.close();
  }
});

// fix-zhiyu-summon-serving-face 1.1/1.2: the overview formation carries the
// a2a serving face (targetId + servingPath) so the gateway's room-summon plan
// can join real pack deployments. The join key is the registry agent path,
// parsed from the a2a catalog entry's url; non-conforming urls (external a2a
// services) yield null — excluded honestly, never guessed.
const { servingPathFromEntryUrl } = await import("../server/routes/fleets.js");

test("servingPathFromEntryUrl: registry /agent<path>/ shape parses; external urls and junk yield null", () => {
  assert.equal(servingPathFromEntryUrl("https://reg.example.test/agent/packs/p1/a1/"), "/packs/p1/a1");
  assert.equal(servingPathFromEntryUrl("https://reg.example.test/agent/packs/p1/a1-suffix"), "/packs/p1/a1-suffix");
  assert.equal(servingPathFromEntryUrl("https://external.example.test/a2a/endpoint"), null, "external a2a url — not a pack deployment");
  assert.equal(servingPathFromEntryUrl("https://reg.example.test/other/path"), null, "pathname not under /agent/");
  assert.equal(servingPathFromEntryUrl("not a url"), null, "malformed url");
  assert.equal(servingPathFromEntryUrl(""), null);
  assert.equal(servingPathFromEntryUrl(null), null);
});

test("overview formation.members: a2a posts carry targetId+servingPath; persona posts carry nulls", async () => {
  const f = makeFleet("召唤面小队");
  fleetDb.createMember({ id: "s1", fleetId: f.id, title: "万星机群席", parentId: null, targetKind: "a2a", targetId: "registry-packs-p1-mp", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "s2", fleetId: f.id, title: "分诊岗", parentId: null, targetKind: "persona", targetId: "persona-x", kpiSlots: [], cadence: null });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { email: "owner@test", groups: [] };
    next();
  });
  // Test-injected resolver stands in for the catalog: the a2a post resolves
  // with a serving url; the persona post resolves without one.
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: (m) => {
      if (m.targetKind === "a2a") {
        return { alive: true, label: "萬星机群席", clusterName: null, servingPath: "/packs/p1/mp-9" };
      }
      return { alive: true, label: "分诊岗", clusterName: null, servingPath: null };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/fleets/overview`, { headers: { "x-test-user": "owner@test" } }).then((x) => x.json());
    const row = r.fleets.find((x) => x.id === f.id);
    const a2a = row.formation.members.find((m) => m.id === "s1");
    const persona = row.formation.members.find((m) => m.id === "s2");
    assert.equal(a2a.targetId, "registry-packs-p1-mp");
    assert.equal(a2a.servingPath, "/packs/p1/mp-9");
    assert.equal(persona.targetId, null, "non-a2a posts report null targetId");
    assert.equal(persona.servingPath, null, "non-a2a posts report null servingPath — keys still present");
  } finally {
    server.close();
  }
});
