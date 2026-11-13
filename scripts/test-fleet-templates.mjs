// Unit tests for fleet templates (agent-fleet-templates).
//
// Covers:
//   - parseFleetTemplate: the legal manifest passes; cycle / bad cron /
//     missing fields / duplicate refs / bad target kinds / oversized slots
//     all refuse with the offending member named
//   - orchestration-in-templates (add-mixed-fleet-packs group A): the
//     fleet.orchestration section parses through the SAME pure validator
//     the live write face uses (member set = template members) — legal
//     sections pass verbatim, ghost refs / unknown kinds / banned shapes
//     refuse structured, an ABSENT section keeps the parse output
//     byte-identical; tool/bot target kinds parse with their shape gates
//   - provisioner + orchestration: the section lands with the fleet (refs
//     rewritten to member ids, degraded posts' edges land too, mode-only
//     sections land verbatim), re-provisioning dedups and never rewrites
//     the owner's later hand-edits; tool/bot targets resolve or degrade
//     per post; export round-trips the live section through the parser
//   - exporter whitelist: the skeleton round-trips through the same parser
//     and carries ZERO runtime traces (reports/decisions/sessions/owner)
//   - provisioner: dedup by sourceTemplate anchor; per-post degradation
//     (missing incumbent → the post still exists, listed in `missing`);
//     ALL-PAUSED at birth (fleet layer + member cadences + parked tasks);
//     the start route flips both layers and reconcile resumes the tasks
//   - template-newer notice: v1-fleet vs installed v2 → updateAvailable,
//     never a mutation
//   - cockpit aggregate: one round-trip with tree/decisions(severity-first)/
//     stream(missing-first)/health/template segments, field-compatible with
//     the previous knives' read faces
//   - from-template route: happy path, dedup response, unknown pack refusal;
//     bot targets resolve through resolveTarget's bots-store branch
//   - official seed library conservation: every seed passes the fleet gate
//     INCLUDING its orchestration section, and each seed's edges match its
//     narrative (pipeline → trigger+handoff/dispatch; inbound wake → event)
//
// Run: node --test scripts/test-fleet-templates.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import { PACK_LIMITS } from "../lib/pack-manifest.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tpl-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const dbModule = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { reconcileFleet } = await import("../server/fleet-reconcile.js");
const { parseFleetTemplate, exportFleetToTemplate } = await import("../server/fleet-template.js");
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await dbModule.initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true }),
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

const ALIVE = (m) => ({ alive: m?.targetId !== "ghost", label: m?.targetId ?? "?", clusterName: null });
// Route-level resolver variant that also treats the provisioner's EMPTY
// targetId sentinel as dead — the real resolveTarget can't find "" in any
// catalog, so vacancy derivation must agree.
const SENTINEL_AWARE = (m) => ({
  alive: !!m?.targetId && m.targetId !== "ghost",
  label: m?.targetId || null,
  clusterName: null,
});
const rosterFn = (id) => id;

function goodManifest() {
  return {
    fleet: {
      name: "公司式舰队",
      members: [
        {
          ref: "ceo",
          title: "CEO",
          parentRef: null,
          target: { kind: "pack-preset", packId: "pack_tpl", presetId: "tpl-ceo" },
          kpiSlots: [{ key: "patrol", label: "巡视要点" }],
          cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", promptTemplate: "巡视各部门 {{fleetContext}}" },
        },
        { ref: "shop", title: "电商部", parentRef: "ceo", target: { kind: "pack-preset", packId: "pack_tpl", presetId: "tpl-shop" }, cadence: { cron: "0 9 * * *", promptTemplate: "报数" } },
        { ref: "assist", title: "助理岗", parentRef: "ceo", target: { kind: "existing-persona", id: "user-assist" }, cadence: null },
      ],
      requires: [{ kind: "a2a", name: "wanxing-cluster", optional: true }],
    },
  };
}

function seedInstalledPack(packId, version, manifest) {
  // The pack's own agents must have MATERIALIZED (catalog reads installed
  // packs' report.agents with status "installed") for pack-preset targets to
  // resolve at the route level.
  dbModule.upsertInstalledPack({
    packId,
    name: manifest.fleet?.name ?? "模板包",
    version,
    manifest: {
      ...manifest,
      ...(manifest.agents ? {} : { agents: [{ id: "tpl-ceo", name: "CEO" }, { id: "tpl-shop", name: "电商部" }] }),
    },
    report: {
      agents: [
        { id: "tpl-ceo", status: "installed" },
        { id: "tpl-shop", status: "installed" },
      ],
      skills: [],
    },
  });
}

// ── 2.1 parser ──────────────────────────────────────────────────────────────

test("parser: legal manifest passes; the three illegal families refuse", () => {
  assert.equal(parseFleetTemplate(goodManifest()).ok, true);
  const template = parseFleetTemplate(goodManifest()).template;
  assert.equal(template.members.length, 3);
  assert.deepEqual(template.requires[0], { kind: "a2a", name: "wanxing-cluster", optional: true });

  // Cycle.
  const cyc = { fleet: { name: "x", members: [
    { ref: "a", title: "A", parentRef: "b", target: { kind: "existing-persona", id: "i" } },
    { ref: "b", title: "B", parentRef: "a", target: { kind: "existing-persona", id: "j" } },
  ] } };
  assert.match(parseFleetTemplate(cyc).error, /cycle/);

  // Bad cron.
  const badCron = goodManifest();
  badCron.fleet.members[1].cadence.cron = "not cron";
  assert.match(parseFleetTemplate(badCron).error, /invalid cron/);

  // Missing fields.
  const noTitle = goodManifest();
  delete noTitle.fleet.members[2].title;
  assert.match(parseFleetTemplate(noTitle).error, /needs a title/);
  const dupRef = goodManifest();
  dupRef.fleet.members[2].ref = "ceo";
  assert.match(parseFleetTemplate(dupRef).error, /duplicate member ref/);
  const badKind = goodManifest();
  badKind.fleet.members[0].target.kind = "magic";
  assert.match(parseFleetTemplate(badKind).error, /target.kind/);

  // No fleet section = plain pack (short-circuit signal).
  assert.match(parseFleetTemplate({ name: "plain" }).error, /no fleet section/);
});

// ── 3.3 exporter whitelist ──────────────────────────────────────────────────

test("exporter: skeleton round-trips; zero runtime traces", () => {
  const fleet = fleetDb.createFleet({ id: "fleet_x", name: "现役舰队", ownerEmail: "owner@test" });
  const ceo = fleetDb.createMember({ id: "m1", fleetId: fleet.id, title: "CEO", parentId: null, targetKind: "persona", targetId: "persona-ceo", kpiSlots: [{ key: "s", label: "S" }], cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  fleetDb.createMember({ id: "m2", fleetId: fleet.id, title: "电商", parentId: "m1", targetKind: "cluster", targetId: "dyn_1", kpiSlots: [], cadence: null });
  // Runtime noise the export must NOT carry.
  fleetDb.appendReport({ id: "r1", fleetId: fleet.id, memberId: ceo.id, sessionId: "sess-secret", metrics: {}, resources: [], blockers: [], summary: "x", source: "self", createdAt: 1 });
  fleetDb.appendDecision({ id: "d1", fleetId: fleet.id, memberId: ceo.id, question: "q", options: [], severity: "low", sourceSessionId: "sess-secret", submittedAt: 1 });

  const exported = exportFleetToTemplate(fleet, fleetDb.listMembers(fleet.id));
  const json = JSON.stringify(exported);
  // The skeleton parses as a valid template (round-trip through the same gate).
  const parsed = parseFleetTemplate(exported);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.template.members[0].target.kind, "existing-persona");
  assert.equal(parsed.template.members[1].target.kind, "existing-cluster");
  assert.equal(parsed.template.members[0].cadence.promptTemplate, "巡视 {{fleetContext}}");
  // Whitelist discipline: none of the runtime identities survive.
  for (const banned of ["sess-secret", "owner@test", "summary", "deliveredAt", "resolution", "memberId"]) {
    assert.ok(!json.includes(banned), `export leaked '${banned}'`);
  }
});

// ── 3.1 provisioner ─────────────────────────────────────────────────────────

function provisionDeps({ catalogIds = new Set(["tpl-ceo", "user-assist"]) } = {}) {
  return {
    db: fleetDb,
    catalogAgentIds: () => catalogIds,
    resolveExisting: ({ kind, id }) => (kind === "persona" ? catalogIds.has(id) : id !== "ghost"),
    reconcile: (fleetId) =>
      reconcileFleet({ fleetId, db: fleetDb, cronApi: cron, resolveTarget: ALIVE, rosterPresetId: rosterFn }),
  };
}

test("provisioner: dedup, degradation, all-paused birth, tasks parked", async () => {
  const manifest = goodManifest();
  // tpl-shop absent from the catalog → the 电商部 post degrades to vacant.
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "user-assist"]) });

  const first = await provisionFleetFromTemplate({ packId: "pack_tpl", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, undefined);
  assert.deepEqual(first.missing.map((m) => m.ref), ["shop"], "per-post degradation listed");
  assert.equal(first.fleet.state, "paused", "fleet-layer pause at birth");

  const members = fleetDb.listMembers(first.fleet.id);
  assert.equal(members.length, 3);
  assert.equal(members.every((m) => !m.cadence || m.cadence.enabled === false), true, "member-layer pause at birth");
  // Materialized tasks exist and park (enabled=false → paused bit true).
  const tasks = cron.listJobs().filter((j) => j.sourceTag?.fleetId === first.fleet.id);
  assert.equal(tasks.length, 2);
  assert.equal(tasks.every((t) => t.paused), true, "install never auto-runs");

  // Dedup: same pack + owner → the same fleet, no twin.
  const again = await provisionFleetFromTemplate({ packId: "pack_tpl", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
  assert.equal(again.fleet.id, first.fleet.id);
});

// ── unique-post conflict degradation (fix-fleet-provisioner-unique-post) ────

test("provisioner: on-duty target conflicts degrade to a staffable vacancy", async () => {
  // user-assist already holds a post in a LIVE fleet…
  const fleetA = fleetDb.createFleet({ id: "fleet_a", name: "现役A", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_a", fleetId: fleetA.id, title: "老助理", parentId: null, targetKind: "persona", targetId: "user-assist", kpiSlots: [], cadence: null });
  // …and the template's assist ref names that same persona. tpl-shop present
  // so NOTHING is missing — the conflict is the only degradation.
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });

  const out = await provisionFleetFromTemplate({ packId: "pack_uc", version: "1.0.0", manifest: goodManifest(), ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, [], "the target exists — nothing is missing");
  assert.deepEqual(out.conflicts.map((c) => c.ref), ["assist"]);
  assert.equal(out.conflicts[0].occupiedBy.postTitle, "老助理");
  assert.equal(out.conflicts[0].occupiedBy.fleetName, "现役A");
  assert.equal(out.conflicts[0].intraTemplate, false);

  // The conflicting post is born with the empty sentinel — the persona keeps
  // exactly ONE post anywhere.
  const assistPost = fleetDb.listMembers(out.fleet.id).find((m) => m.title === "助理岗");
  assert.equal(assistPost.targetId, "");
  const holders = [fleetA.id, out.fleet.id]
    .flatMap((fid) => fleetDb.listMembers(fid))
    .filter((m) => m.targetId === "user-assist");
  assert.equal(holders.length, 1, "no second post on the incumbent");
});

test("provisioner: intra-template duplicate conflicts; a2a exempt", async () => {
  const dup = goodManifest();
  dup.fleet.members.push({ ref: "assist2", title: "助理二岗", parentRef: "ceo", target: { kind: "existing-persona", id: "user-assist" }, cadence: null });
  dup.fleet.members.push({ ref: "wx", title: "萬星岗", parentRef: "ceo", target: { kind: "existing-a2a", id: "wx-a" }, cadence: null });
  dup.fleet.members.push({ ref: "wx2", title: "萬星二岗", parentRef: "ceo", target: { kind: "existing-a2a", id: "wx-a" }, cadence: null });
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });

  const out = await provisionFleetFromTemplate({ packId: "pack_dup", version: "1.0.0", manifest: dup, ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true);
  // The SECOND claim of user-assist conflicts with the first post of THIS
  // batch (no other fleet involved) — occupiedBy stays null.
  assert.deepEqual(out.conflicts.map((c) => c.ref), ["assist2"]);
  assert.equal(out.conflicts[0].intraTemplate, true);
  assert.equal(out.conflicts[0].occupiedBy, null);
  const members = fleetDb.listMembers(out.fleet.id);
  assert.equal(members.find((m) => m.title === "助理岗").targetId, "user-assist", "first claim keeps the target");
  assert.equal(members.find((m) => m.title === "助理二岗").targetId, "", "second claim gets the sentinel");
  // a2a is exempt from uniqueness (D8): both 萬星 posts hold the target.
  assert.equal(out.conflicts.some((c) => c.ref.startsWith("wx")), false);
  assert.equal(members.filter((m) => m.targetId === "wx-a").length, 2);
});

test("start route: flips both pause layers, reconcile resumes, notice-only upgrades", async () => {
  const manifest = goodManifest();
  const deps = provisionDeps();
  const { fleet } = await provisionFleetFromTemplate({ packId: "pack_start", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // The notice before any upgrade: exact version → no notice payload churn.
    seedInstalledPack("pack_start", "1.0.0", manifest);
    const before = await call("GET", `/api/fleets/${fleet.id}/cockpit`);
    assert.equal(before.status, 200);
    assert.equal(before.body.fleet.state, "paused");
    assert.equal(before.body.template.updateAvailable, false);

    // Start: both layers flip; the parked tasks resume.
    const started = await call("POST", `/api/fleets/${fleet.id}/start`);
    assert.equal(started.status, 200);
    assert.equal(started.body.fleet.state, "active");
    const _afterTasks = cron.listJobs().filter((j) => j.sourceTag?.fleetId === fleet.id && j.target.preset === "tpl-shop" ? false : true);
    assert.equal(cron.listJobs().filter((j) => j.sourceTag?.fleetId === fleet.id).every((t) => !t.paused), true, "tasks resumed after start");

    // Template-newer (D7): publish v2 → notice appears, the LIVE fleet is
    // untouched (no member/cadence change, no new fleet).
    seedInstalledPack("pack_start", "2.0.0", manifest);
    const cockpit = await call("GET", `/api/fleets/${fleet.id}/cockpit`);
    assert.equal(cockpit.body.template.updateAvailable, true);
    assert.equal(cockpit.body.template.latestVersion, "2.0.0");
    assert.deepEqual(
      fleetDb.listMembers(fleet.id).map((m) => m.title).sort(),
      fleetDb.listMembers(fleet.id).map((m) => m.title).sort(),
    );
    assert.equal(fleetDb.listFleets({ ownerEmail: "owner@test" }).length, 1, "no twin from the notice");
  } finally {
    server.close();
  }
});

// ── 1.1 cockpit aggregate + from-template route ────────────────────────────

test("from-template route + cockpit segments in one round-trip", async () => {
  const manifest = goodManifest();
  seedInstalledPack("pack_rt", "1.0.0", manifest);

  const app = express();
  app.use(express.json());
  const ctx = {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
    currentPreset: null,
  };
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const unknown = await call("POST", "/api/fleets/from-template", { packId: "nope" });
    assert.equal(unknown.status, 400);

    const created = await call("POST", "/api/fleets/from-template", { packId: "pack_rt" });
    assert.equal(created.status, 201);
    assert.equal(created.body.fleet.state, "paused");
    assert.deepEqual(created.body.missing.map((m) => m.ref), ["assist"], "the existing-persona ref is absent here → degraded, pack presets resolved");

    const deduped = await call("POST", "/api/fleets/from-template", { packId: "pack_rt" });
    assert.equal(deduped.status, 200);
    assert.equal(deduped.body.fleet.id, created.body.fleet.id);

    // Open a decision on the CEO post to exercise the banner's ordering, and
    // a report so the stream has one row.
    const ceoMember = fleetDb.listMembers(created.body.fleet.id).find((m) => m.title === "CEO");
    fleetDb.appendDecision({
      id: "d_low", fleetId: created.body.fleet.id, memberId: ceoMember.id,
      question: "低优", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", submittedAt: Date.now() - 3600_000,
    });
    fleetDb.appendDecision({
      id: "d_high", fleetId: created.body.fleet.id, memberId: ceoMember.id,
      question: "高优", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "high", submittedAt: Date.now(),
    });
    fleetDb.appendReport({ id: "r_ceo", fleetId: created.body.fleet.id, memberId: ceoMember.id, sessionId: "s", metrics: {}, resources: [], blockers: [], summary: "首报", source: "self", createdAt: Date.now() });

    const cockpit = await call("GET", `/api/fleets/${created.body.fleet.id}/cockpit`);
    assert.equal(cockpit.status, 200);
    // Segments all present in ONE payload.
    assert.ok(cockpit.body.members.length === 3);
    assert.ok(cockpit.body.decisions.length === 2);
    assert.deepEqual(cockpit.body.decisions.map((d) => d.id), ["d_high", "d_low"], "severity-first ordering");
    assert.ok(cockpit.body.decisions[0].expiresAt > 0, "policy-expiry sort key rides");
    assert.equal(cockpit.body.stream.length, 3);
    assert.equal(cockpit.body.stream[0].memberId, cockpit.body.stream[0].memberId); // shape
    assert.ok(cockpit.body.health && cockpit.body.health.total === 3);
    assert.equal(cockpit.body.template.updateAvailable, false);
    // The tree members carry the previous knives' contracts verbatim.
    const ceoView = cockpit.body.members.find((m) => m.title === "CEO");
    assert.equal(typeof ceoView.status, "string");
    assert.ok(ceoView.latestReport);
    assert.equal(ceoView.latestReport.summary, "首报");
  } finally {
    server.close();
  }
});

// ── 1.1 from-template unique-post conflict leg ──────────────────────────────

test("from-template route: conflict surfaces, sentinel reads vacant, swap staffs it", async () => {
  seedInstalledPack("pack_uc", "1.0.0", goodManifest());
  // user-assist must be a LIVE catalog persona at route level — a dead target
  // would take the missing path instead of the conflict path.
  dbModule.upsertInstalledPack({
    packId: "pack_ppl",
    name: "人员包",
    version: "1.0.0",
    manifest: { agents: [{ id: "user-assist", name: "用户助理" }] },
    report: { agents: [{ id: "user-assist", status: "installed" }], skills: [] },
  });
  // …and on duty in a live fleet.
  const fleetA = fleetDb.createFleet({ id: "fleet_a", name: "现役A", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_a", fleetId: fleetA.id, title: "老助理", parentId: null, targetKind: "persona", targetId: "user-assist", kpiSlots: [], cadence: null });

  const app = express();
  app.use(express.json());
  const ctx = { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: SENTINEL_AWARE, currentPreset: null };
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const created = await call("POST", "/api/fleets/from-template", { packId: "pack_uc" });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.missing, []);
    assert.equal(created.body.conflicts.length, 1);
    assert.equal(created.body.conflicts[0].ref, "assist");
    assert.equal(created.body.conflicts[0].occupiedBy.postTitle, "老助理");
    assert.equal(created.body.conflicts[0].occupiedBy.fleetName, "现役A");

    // Same-source contrast: a MANUAL post on the busy persona still 409s —
    // the provisioner is now the third write path agreeing with 建岗.
    const mk = await call("POST", `/api/fleets/${created.body.fleet.id}/members`, {
      title: "插岗", targetKind: "persona", targetId: "user-assist",
    });
    assert.equal(mk.status, 409);

    // Cockpit: the sentinel post reads vacant with the conflict reason.
    const cockpit = await call("GET", `/api/fleets/${created.body.fleet.id}/cockpit`);
    assert.equal(cockpit.status, 200);
    const assist = cockpit.body.members.find((m) => m.title === "助理岗");
    assert.equal(assist.status, "vacant");
    assert.match(assist.statusReason, /conflict/i);
    assert.equal(assist.target.id, "");
    assert.equal(assist.target.label, null, "no fake label for the sentinel");

    // Free the incumbent (dissolve archives A), then 补岗 via swap — the
    // vacancy is staffable through the ordinary restaffing route.
    const gone = await call("DELETE", `/api/fleets/${fleetA.id}`);
    assert.equal(gone.status, 200);
    const swap = await call("POST", `/api/fleets/${created.body.fleet.id}/members/${assist.id}/swap`, {
      targetKind: "persona", targetId: "user-assist",
    });
    assert.equal(swap.status, 200);
    assert.equal(swap.body.member.target.id, "user-assist");
    assert.notEqual(swap.body.member.status, "vacant");
  } finally {
    server.close();
  }
});

// ── official seed library conservation (add-fleet-template-library) ────────
// Every seed under docs/fleet-templates/ is the manifest source of truth for a
// market-published pack. Rot (an illegal fleet section) must fail HERE, naming
// the offending file — not surface at casting time on the market side.
// Since add-mixed-fleet-packs the gate ALSO covers each seed's orchestration
// section (parseFleetTemplate validates it with the live write face's
// validator), and the narrative contract is pinned per file: pipeline
// narratives carry trigger+handoff/dispatch chains, the inbound-wake narrative
// carries a bot: event edge (spec: 官方种子库守恒).

// Per-file narrative floor: each seed's orchestration must carry AT LEAST
// these edge kinds (counts are minimums, the stories may grow).
const SEED_ORCHESTRATION_NARRATIVE = {
  "company-fleet.seed.json": { dispatch: 1 }, // supervisor-style CEO dispatch
  "content-factory-fleet.seed.json": { trigger: 1, handoff: 2, dispatch: 1 }, // weekly pipeline
  "intel-brief-fleet.seed.json": { trigger: 1, handoff: 1 }, // patrol→handoff→digest chain
  "invest-morning-fleet.seed.json": { trigger: 1, handoff: 1 }, // cascade morning meeting
  // add-investment-trading-fleet: 盘前研究→组合→开盘执行（handoff 串起），
  // 收盘复盘独立窗口（trigger），执行受阻时派单给被动风控岗（dispatch）。
  "invest-trading-fleet.seed.json": { trigger: 4, handoff: 2, dispatch: 1 },
  "service-desk-fleet.seed.json": { trigger: 1, event: 1 }, // inbound bot wake
  "product-intro-fleet.seed.json": { dispatch: 5 }, // receptionist star: guide→5 line experts (add-product-intro-team)
  // add-personal-staff-fleet: 幕僚长分诊到三个执行岗（评审/侦查/书记）。审计官**不在**
  // 任何边上——它不进工作图（auditor_not_orchestratable）：盯拍板队列里的判断，
  // 裁决经 auditor_submit_verdict 回到主人，不靠编导边驱动。
  //
  // 该种子的表目要随种子一起落地，所以这里先不写：
  // `personal-staff-fleet.seed.json`（连同 openspec/changes/add-personal-staff-fleet/）
  // 目前只存在于 fix/fleet-attribution-admission 那条线上、尚未进本分支。
  // 提前把表目写进来会让「表 == 盘上种子」这条断言对本分支永远红——而这句红话
  // （"every official fleet seed has a narrative entry"）指向的是本分支根本没有的文件。
  // 等那条线并进来时把这一行恢复即可：{ dispatch: 3 }（幕僚长→评审/侦查/书记）。
};

test("official seed library: every manifest passes the fleet-section gate", async () => {
  const dir = new URL("../docs/fleet-templates/", import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".seed.json")).sort();
  assert.ok(files.length >= 5, `expected the seed library to hold at least 5 seeds, found ${files.length}`);
  assert.deepEqual(
    files.filter((f) => SEED_ORCHESTRATION_NARRATIVE[f]),
    Object.keys(SEED_ORCHESTRATION_NARRATIVE).sort(),
    "every official fleet seed has a narrative entry here — new seeds must declare one",
  );

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(new URL(file, dir), "utf8"));
    // The seed carries {{PLACEHOLDER}} ids for the casting step to substitute —
    // substitute benign values and the manifest MUST clear the shared parser.
    const filled = JSON.parse(
      JSON.stringify(raw).replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (key === "PACK_ID" ? "pack_seed" : `${key.toLowerCase()}-ref`)),
    );
    const parsed = parseFleetTemplate(filled);
    assert.equal(parsed.ok, true, `${file}: ${parsed.error}`);

    // Self-carried agents cap — the market-policy ceiling (PACK_LIMITS,
    // raised 3 → 50 on 2026-10-30), not a hard-coded guess.
    assert.ok(Array.isArray(raw.agents) && raw.agents.length <= PACK_LIMITS.maxAgents, `${file}: pack agents must be at most ${PACK_LIMITS.maxAgents}, found ${raw.agents?.length}`);

    // Every post that binds a self-carried preset names one, and every
    // self-carried agent is referenced by exactly one such post (1:1, no
    // orphans). Two target kinds bind a self-carried preset: `pack-preset`
    // and `auditor`（审计官是有工具面约束的预设，不是另一种来源）——两者
    // 合起来比，否则带审计官的种子会被这条 1:1 误判成「有孤儿预设」。
    const boundPresetIds = parsed.template.members.flatMap((m) =>
      m.target.kind === "pack-preset" ? [m.target.presetId] : m.target.kind === "auditor" ? [m.target.id] : [],
    );
    const agentIds = (raw.agents ?? []).map((a) => a.id);
    assert.deepEqual(
      [...boundPresetIds].sort(),
      [...agentIds].sort(),
      `${file}: agents[] must correspond 1:1 with pack-preset/auditor posts`,
    );

    // Orchestration conservation (add-mixed-fleet-packs 1.6): every seed
    // carries a section, it cleared the shared validator above (parse fails
    // otherwise), and its edge-kind census meets the narrative floor.
    const orchestration = parsed.template.orchestration;
    assert.ok(orchestration && Array.isArray(orchestration.edges) && orchestration.edges.length > 0, `${file}: seed must carry an orchestration section with edges`);
    const census = {};
    for (const e of orchestration.edges) census[e.kind] = (census[e.kind] ?? 0) + 1;
    for (const [kind, min] of Object.entries(SEED_ORCHESTRATION_NARRATIVE[file] ?? {})) {
      assert.ok((census[kind] ?? 0) >= min, `${file}: narrative needs ≥${min} '${kind}' edge(s), found ${census[kind] ?? 0}`);
    }
    // Inbound-wake seeds: the event edge must be an external bot: source
    // waking an in-set post (the validator pins the rest).
    for (const e of orchestration.edges.filter((x) => x.kind === "event")) {
      assert.match(e.from, /^bot:/, `${file}: event edge from must be an external bot: source`);
    }

    assert.ok(
      parsed.template.members.every((m) => !m.cadence || m.cadence.promptTemplate.includes("{{fleetContext}}")),
      `${file}: every cadence template carries the patrol placeholder`,
    );
  }
});

// The original single-seed pin, kept as the company fleet's shape contract.
test("official seed manifest (company fleet) passes the fleet-section gate", async () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../docs/fleet-templates/company-fleet.seed.json", import.meta.url), "utf8"));
  const filled = JSON.parse(JSON.stringify(raw).replace(/\{\{PACK_ID\}\}/g, "pack_seed").replace(/\{\{SHOP_PERSONA\}\}/g, "shop-p").replace(/\{\{CONTENT_PERSONA\}\}/g, "content-p").replace(/\{\{ASSIST_PERSONA\}\}/g, "assist-p").replace(/\{\{WANXING_CLUSTER\}\}/g, "wx-cluster"));
  const parsed = parseFleetTemplate(filled);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.template.members.length, 7);
  assert.equal(parsed.template.members.filter((m) => m.cadence).length, 6, "six cadence posts + one passive (内容部)");
  assert.ok(parsed.template.members.every((m) => !m.cadence || m.cadence.promptTemplate.includes("{{fleetContext}}")), "every cadence template carries the patrol placeholder");
});

// ── orchestration-in-templates (add-mixed-fleet-packs, group A) ────────────

// goodManifest() + a pipeline orchestration section. 'shop' DEGRADES under the
// default deps (tpl-shop absent from the catalog) — on purpose: the degraded
// post's edges must land anyway (edges reference posts, not targets).
function orchestrationManifest() {
  const manifest = goodManifest();
  manifest.fleet.orchestration = {
    edges: [
      { kind: "trigger", to: "ceo", cron: "0 * * * *" },
      { kind: "handoff", from: "ceo", to: "shop" },
      { kind: "dispatch", from: "shop", to: "assist" },
    ],
  };
  return manifest;
}

test("orchestration parse: legal section passes verbatim; ghosts/unknown kinds/banned shapes refuse; absent section stays byte-identical", () => {
  // Legal: carried through untouched.
  const legal = parseFleetTemplate(orchestrationManifest());
  assert.equal(legal.ok, true, legal.error);
  assert.deepEqual(legal.template.orchestration, orchestrationManifest().fleet.orchestration);

  // Ghost ref: the refusal names the edge AND the missing post (spec
  // scenario: 编导引用成员集外岗位被拒).
  const ghost = orchestrationManifest();
  ghost.fleet.orchestration.edges[1].to = "ghost";
  const refused = parseFleetTemplate(ghost);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /fleet\.orchestration/);
  assert.match(refused.error, /does not match a member/);
  assert.ok(Array.isArray(refused.errors) && refused.errors.length > 0, "structured errors ride along");

  // Unknown edge kind.
  const mystery = orchestrationManifest();
  mystery.fleet.orchestration.edges[1].kind = "mystery";
  assert.match(parseFleetTemplate(mystery).error, /kind must be one of/);

  // Banned shape: edges not an array.
  const notArray = orchestrationManifest();
  notArray.fleet.orchestration.edges = { 0: "nope" };
  assert.match(parseFleetTemplate(notArray).error, /edges must be an array/);

  // Banned target: an event edge may only wake persona/a2a posts — the
  // cluster member 'shop'… shop is a preset (persona), so use a real cluster.
  const evBad = goodManifest();
  evBad.fleet.members.push({ ref: "clu", title: "集群岗", parentRef: "ceo", target: { kind: "existing-cluster", id: "clu-1" }, cadence: null });
  evBad.fleet.orchestration = { edges: [{ kind: "event", from: "bot:helper", to: "clu" }] };
  assert.match(parseFleetTemplate(evBad).error, /persona\/a2a post/);
  // …and the legal twin passes (persona target).
  const evOk = goodManifest();
  evOk.fleet.orchestration = { edges: [{ kind: "event", from: "bot:helper", to: "assist" }] };
  assert.equal(parseFleetTemplate(evOk).ok, true, parseFleetTemplate(evOk).error);

  // Explicit null = "explicitly no edges" — passes and rides along (the live
  // write face treats null the same way).
  const nullSection = goodManifest();
  nullSection.fleet.orchestration = null;
  const parsedNull = parseFleetTemplate(nullSection);
  assert.equal(parsedNull.ok, true);
  assert.equal(parsedNull.template.orchestration, null);

  // ABSENT section: byte-identical short-circuit — the parse output carries
  // no orchestration key and deep-equals the key-less parse, whether the
  // section was never there or explicitly undefined.
  const base = parseFleetTemplate(goodManifest()).template;
  assert.equal("orchestration" in base, false);
  const explicitUndefined = goodManifest();
  explicitUndefined.fleet.orchestration = undefined;
  assert.deepEqual(parseFleetTemplate(explicitUndefined).template, base);
});

test("orchestration parse: tool and bot target kinds take their shape gates", () => {
  const toolManifest = () => {
    const m = goodManifest();
    m.fleet.members.push({
      ref: "toolpost", title: "工具岗", parentRef: "ceo",
      target: { kind: "tool", id: "server::tool" }, cadence: null,
    });
    return m;
  };

  // Legal tool target + a handoff edge carrying its JSON args.
  const okTool = toolManifest();
  okTool.fleet.orchestration = { edges: [{ kind: "handoff", from: "ceo", to: "toolpost", args: { tool: "run" } }] };
  const parsedTool = parseFleetTemplate(okTool);
  assert.equal(parsedTool.ok, true, parsedTool.error);
  assert.equal(parsedTool.template.members.at(-1).target.kind, "tool");

  // Illegal tool shape: the id must be the 'namespace::tool' contract.
  const badTool = toolManifest();
  badTool.fleet.members.at(-1).target.id = "not-a-tool-name";
  assert.match(parseFleetTemplate(badTool).error, /tool target\.id must be 'server::tool'/);

  // A tool member WITH cadence: the prompt IS the tool's args — a JSON object.
  const toolCadence = toolManifest();
  toolCadence.fleet.members.at(-1).cadence = { cron: "0 9 * * *", promptTemplate: '{"query":"daily"}' };
  assert.equal(parseFleetTemplate(toolCadence).ok, true);
  const toolCadenceBad = toolManifest();
  toolCadenceBad.fleet.members.at(-1).cadence = { cron: "0 9 * * *", promptTemplate: "not json" };
  assert.match(parseFleetTemplate(toolCadenceBad).error, /must be a JSON object/);

  // Bot target: any bot id (pack bot or incumbent) — shape gate is just "an
  // id"; existence is an instantiation-time fact.
  const botManifest = goodManifest();
  botManifest.fleet.members.push({ ref: "botpost", title: "客服 bot 岗", parentRef: "ceo", target: { kind: "bot", id: "bot_desk" }, cadence: null });
  botManifest.fleet.orchestration = { edges: [{ kind: "event", from: "bot:bot_desk", to: "botpost" }] };
  // event 'to' must be persona/a2a — a bot POST is not woken by events (it
  // IS the source); the wake lane is event→persona/a2a. Use dispatch instead.
  const evToBot = parseFleetTemplate(botManifest);
  assert.equal(evToBot.ok, false, "event edges cannot wake a bot post");
  assert.match(evToBot.error, /persona\/a2a post/);
  botManifest.fleet.orchestration = { edges: [{ kind: "dispatch", from: "ceo", to: "botpost" }] };
  const parsedBot = parseFleetTemplate(botManifest);
  assert.equal(parsedBot.ok, true, parsedBot.error);
  assert.equal(parsedBot.template.members.at(-1).target.kind, "bot");

  const botNoId = goodManifest();
  botNoId.fleet.members.push({ ref: "botpost", title: "无 id bot 岗", parentRef: "ceo", target: { kind: "bot" }, cadence: null });
  assert.match(parseFleetTemplate(botNoId).error, /bot target needs an id/);
});

test("provisioner: orchestration lands with the fleet — refs rewritten to member ids, degraded posts' edges land, first trigger parks", async () => {
  const deps = provisionDeps(); // shop (tpl-shop) degrades, assist resolves
  const out = await provisionFleetFromTemplate({ packId: "pack_orch", version: "1.0.0", manifest: orchestrationManifest(), ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.missing.map((m) => m.ref), ["shop"], "the degraded post is per-post, never the fleet");

  // The section landed on the fleet with REFS swapped for member ids — and
  // the handoff INTO the degraded shop post landed anyway (edges reference
  // posts, not the targets behind them).
  const fleet = fleetDb.getFleet(out.fleet.id);
  const { memberIdByRef } = out;
  assert.ok(fleet.orchestration, "the fleet is born carrying its edges");
  const handoff = fleet.orchestration.edges.find((e) => e.kind === "handoff");
  assert.equal(handoff.from, memberIdByRef.ceo);
  assert.equal(handoff.to, memberIdByRef.shop, "the degraded post's edge landed");
  const trigger = fleet.orchestration.edges.find((e) => e.kind === "trigger");
  assert.equal(trigger.to, memberIdByRef.ceo);
  // Trigger cadence materialization stays the ordinary paused-at-birth story.
  const tasks = cron.listJobs().filter((j) => j.sourceTag?.fleetId === out.fleet.id);
  assert.ok(tasks.length >= 1 && tasks.every((t) => t.paused), "first trigger materialization parks (待启动)");

  // No section → the fleet is born with none (absent stays absent — the row
  // deserializes a NULL column as null).
  const plain = await provisionFleetFromTemplate({ packId: "pack_plain", version: "1.0.0", manifest: goodManifest(), ownerEmail: "owner@test", deps });
  assert.equal(plain.ok, true);
  assert.ok(!fleetDb.getFleet(plain.fleet.id).orchestration);
});

test("provisioner: mode-only orchestration lands verbatim (no edges key)", async () => {
  const manifest = goodManifest();
  manifest.fleet.orchestration = { mode: "supervisor" };
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  const out = await provisionFleetFromTemplate({ packId: "pack_super", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(fleetDb.getFleet(out.fleet.id).orchestration, { mode: "supervisor" });
});

test("provisioner: re-provision dedups and never rewrites the owner's orchestration", async () => {
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  const manifest = orchestrationManifest();
  const first = await provisionFleetFromTemplate({ packId: "pack_re", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(first.ok, true);

  // The owner hand-rewrites the section through the write face after birth.
  const ownerEdge = { kind: "handoff", from: first.memberIdByRef.shop, to: first.memberIdByRef.ceo };
  fleetDb.updateFleet(first.fleet.id, { orchestration: { edges: [ownerEdge] } });

  const again = await provisionFleetFromTemplate({ packId: "pack_re", version: "2.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true, "no twin fleet");
  assert.equal(again.fleet.id, first.fleet.id);
  assert.deepEqual(
    fleetDb.getFleet(first.fleet.id).orchestration.edges,
    [ownerEdge],
    "the owner's rewrite survives re-provisioning — the template never rewrites a live fleet's section",
  );
});

test("exporter: the live orchestration section round-trips through the parser", async () => {
  // A live fleet carrying a hand-written section (member ids in the edges).
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  const src = await provisionFleetFromTemplate({ packId: "pack_exp", version: "1.0.0", manifest: orchestrationManifest(), ownerEmail: "owner@test", deps });
  const fleet = fleetDb.getFleet(src.fleet.id);
  const members = fleetDb.listMembers(fleet.id);

  const exported = exportFleetToTemplate(fleet, members);
  // The export's refs ARE the member ids, so the section re-parses unchanged.
  const parsed = parseFleetTemplate(exported);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.template.orchestration, fleet.orchestration, "export → parse keeps every edge byte-for-byte");
});

test("provisioner: tool targets — routable resolves, dead server degrades to a vacant post whose edges land", async () => {
  const toolManifest = () => {
    const m = goodManifest();
    m.fleet.members.push({
      ref: "toolpost", title: "工具岗", parentRef: "ceo",
      target: { kind: "tool", id: "server::tool" }, cadence: null,
    });
    m.fleet.orchestration = { edges: [{ kind: "handoff", from: "ceo", to: "toolpost", args: { query: "hi" } }] };
    return m;
  };

  // Resolves: the post holds the tool name, nothing is missing.
  const okDeps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  okDeps.resolveExisting = ({ kind, id }) => (kind === "tool" ? true : id !== "ghost");
  const ok = await provisionFleetFromTemplate({ packId: "pack_tool_ok", version: "1.0.0", manifest: toolManifest(), ownerEmail: "owner@test", deps: okDeps });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);
  const toolPost = fleetDb.listMembers(ok.fleet.id).find((m) => m.title === "工具岗");
  assert.equal(toolPost.targetKind, "tool");
  assert.equal(toolPost.targetId, "server::tool");

  // Dead server: same philosophy as a2a — the post degrades to vacant, the
  // handoff-into-tool edge lands anyway.
  const deadDeps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  deadDeps.resolveExisting = ({ kind }) => (kind === "tool" ? false : true);
  const dead = await provisionFleetFromTemplate({ packId: "pack_tool_dead", version: "1.0.0", manifest: toolManifest(), ownerEmail: "owner@test", deps: deadDeps });
  assert.equal(dead.ok, true);
  assert.deepEqual(dead.missing.map((m) => m.ref), ["toolpost"], "unroutable tool server → per-post degradation");
  const landed = fleetDb.getFleet(dead.fleet.id).orchestration.edges.find((e) => e.kind === "handoff");
  assert.equal(landed.to, dead.memberIdByRef.toolpost, "the edge into the vacant tool post landed");
});

test("provisioner: bot targets — incumbent resolves, missing instance degrades", async () => {
  const botManifest = () => {
    const m = goodManifest();
    m.fleet.members.push({ ref: "botpost", title: "客服 bot 岗", parentRef: "ceo", target: { kind: "bot", id: "bot_desk_tpl" }, cadence: null });
    m.fleet.orchestration = { edges: [{ kind: "dispatch", from: "ceo", to: "botpost" }] };
    return m;
  };

  const hereDeps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  hereDeps.resolveExisting = ({ kind, id }) => (kind === "bot" ? id === "bot_desk_tpl" : id !== "ghost");
  const here = await provisionFleetFromTemplate({ packId: "pack_bot_ok", version: "1.0.0", manifest: botManifest(), ownerEmail: "owner@test", deps: hereDeps });
  assert.equal(here.ok, true);
  assert.deepEqual(here.missing, []);
  const botPost = fleetDb.listMembers(here.fleet.id).find((m) => m.title === "客服 bot 岗");
  assert.equal(botPost.targetKind, "bot");
  assert.equal(botPost.targetId, "bot_desk_tpl");

  const goneDeps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });
  goneDeps.resolveExisting = ({ kind, id }) => (kind === "bot" ? false : id !== "ghost");
  const gone = await provisionFleetFromTemplate({ packId: "pack_bot_gone", version: "1.0.0", manifest: botManifest(), ownerEmail: "owner@test", deps: goneDeps });
  assert.equal(gone.ok, true);
  assert.deepEqual(gone.missing.map((m) => m.ref), ["botpost"], "missing bot instance → 待补岗, never fleet failure");
  const dispatch = fleetDb.getFleet(gone.fleet.id).orchestration.edges.find((e) => e.kind === "dispatch");
  assert.equal(dispatch.to, gone.memberIdByRef.botpost, "the edge referencing the post (not the bot) landed");
});

test("route: from-template resolves bot targets through resolveTarget's bots-store branch", async () => {
  const manifest = goodManifest();
  manifest.fleet.members.push({ ref: "botpost", title: "客服 bot 岗", parentRef: "ceo", target: { kind: "bot", id: "bot_route_tpl" }, cadence: null });
  seedInstalledPack("pack_bot_route", "1.0.0", manifest);

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: ALIVE, currentPreset: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // No bot instance in the cell yet → the post degrades (missing), pack
    // bots and incumbents resolve through the SAME store.
    const vacant = await call("POST", "/api/fleets/from-template", { packId: "pack_bot_route" });
    assert.equal(vacant.status, 201);
    assert.ok(vacant.body.missing.some((m) => m.ref === "botpost"), "absent bot → 待补岗 via resolveTarget");

    // Dissolve the vacant fleet, materialize the incumbent (an
    // operator-configured channel bot), re-provision — now the branch
    // resolves alive (same owner re-runs would dedup onto the old fleet).
    const gone = await call("DELETE", `/api/fleets/${vacant.body.fleet.id}`);
    assert.equal(gone.status, 200);
    dbModule.addBot({ id: "bot_route_tpl", type: "feishu", name: "客服通道", credentials: {}, secret: "s" });
    const staffed = await call("POST", "/api/fleets/from-template", { packId: "pack_bot_route" });
    assert.equal(staffed.status, 201);
    assert.equal(staffed.body.missing.some((m) => m.ref === "botpost"), false, "present bot resolves through the bots store");
    const post = fleetDb.listMembers(staffed.body.fleet.id).find((m) => m.title === "客服 bot 岗");
    assert.equal(post.targetKind, "bot");
    assert.equal(post.targetId, "bot_route_tpl");
  } finally {
    server.close();
  }
});

// ── 7.2 回链投影：来源蓝图 id 必须同时出现在两个读面 ────────────────────────
// 生产走查实录（2026-11-03）：投影最初只挂在 GET /:id，而舰队详情面板实际拉
// GET /:id/cockpit——芯片永远不现。两读面同钉，投影漂移当场红。
test("7.2 back-link: blueprintId rides BOTH cockpit and bare detail", async () => {
  const m = goodManifest();
  seedInstalledPack("pack_cast", "1.0.0", {
    ...m,
    _casting: { source: "fleet-blueprint-studio", blueprintId: "bp_cast_42", approvedBy: "owner@test" },
  });
  const app = express();
  app.use(express.json());
  const ctx = { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: ALIVE, currentPreset: null };
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const created = await fetch(`${base}/api/fleets/from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packId: "pack_cast" }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    assert.equal(created.status, 201);
    const id = created.body.fleet.id;
    assert.equal(created.body.fleet.sourceTemplate.packId, "pack_cast");

    const cockpit = await get(`/api/fleets/${id}/cockpit`);
    assert.equal(cockpit.status, 200);
    assert.equal(cockpit.body.blueprintId, "bp_cast_42", "the page's ACTUAL read face carries the projection");

    const detail = await get(`/api/fleets/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.blueprintId, "bp_cast_42", "the bare detail agrees");

    // Honest absence: a fleet with no template origin projects null.
    const plain = fleetDb.createFleet({ id: "fleet_plain_cast", name: "手建", ownerEmail: "owner@test" });
    const plainCockpit = await get(`/api/fleets/${plain.id}/cockpit`);
    assert.equal(plainCockpit.status, 200);
    assert.equal(plainCockpit.body.blueprintId, null, "no template → null, not undefined-key drift");
  } finally {
    server.close();
  }
});

// ── auditor 可作为模板目标（2026-11-10）─────────────────────────────────────
//
// 审计官是第五种岗位承载。模板不能表达它，就没法「一键起一支带审计的幕僚团」，
// 每个想用审计官的人都得手工建岗——而那正是最容易漏的一岗。

test("template: a member may target an auditor (round-trips through export)", async () => {
  const { parseFleetTemplate, exportFleetToTemplate, TEMPLATE_TARGET_KINDS } = await import("../server/fleet-template.js");
  assert.ok(TEMPLATE_TARGET_KINDS.includes("auditor"), "auditor 必须在模板目标类型里");

  const fleet = {
    name: "个人幕僚团",
    params: [
      { name: "chiefPersona", type: "string" },
      { name: "chiefCron", type: "string" },
      { name: "auditorPersona", type: "string" },
      { name: "auditorCron", type: "string" },
    ],
    members: [
      { ref: "chief", title: "幕僚长", parentRef: null,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template's own ${...} placeholder — mint substitutes it, JS never does
        target: { kind: "existing-persona", id: "${chiefPersona}" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template's own ${...} placeholder — mint substitutes it, JS never does
        cadence: { cron: "${chiefCron}", tz: "Asia/Shanghai", promptTemplate: "分诊" } },
      { ref: "auditor", title: "审计官", parentRef: "chief",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template's own ${...} placeholder — mint substitutes it, JS never does
        target: { kind: "auditor", id: "${auditorPersona}" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the template's own ${...} placeholder — mint substitutes it, JS never does
        cadence: { cron: "${auditorCron}", tz: "Asia/Shanghai", promptTemplate: "复核" } },
    ],
  };
  const parsed = parseFleetTemplate({ fleet });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors ?? parsed.error));
  assert.deepEqual(parsed.template.members.map((m) => m.target.kind), ["existing-persona", "auditor"]);

  // 导出必须能把 auditor 原样写回模板，否则「导出为模板」会把它降级成普通 persona
  const exported = exportFleetToTemplate(
    { name: "个人幕僚团" },
    [
      { id: "m_chief", title: "幕僚长", parentId: null, targetKind: "persona", targetId: "p1", kpiSlots: [], cadence: null },
      { id: "m_aud", title: "审计官", parentId: "m_chief", targetKind: "auditor", targetId: "p2", kpiSlots: [], cadence: null },
    ],
  );
  assert.equal(exported.fleet.members[1].target.kind, "auditor", "导出不得把审计官降级");
});

// ── 审计官模板落地后必须**仍然是** auditor（2026-11-10）──────────────────────
//
// 上一版只在「解析/导出」两层支持 auditor。实例化器没有对应分支，targetKind
// 会回落到 "persona"——岗位还在、名字还在，「会唱反调」这件事没了，且零报错。
// 这条测试盯的是落地面，不是形状面。

test("template: provisioning an auditor member yields targetKind=auditor, not persona", async () => {
  const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
  const created = [];
  const out = await provisionFleetFromTemplate({
    packId: "pack_x",
    version: "1.0.0",
    ownerEmail: "owner@test",
    manifest: {
      fleet: {
        name: "个人幕僚团",
        members: [
          { ref: "chief", title: "幕僚长", parentRef: null,
            target: { kind: "existing-persona", id: "preset-chief" }, cadence: null },
          { ref: "aud", title: "审计官", parentRef: "chief",
            target: { kind: "auditor", id: "preset-aud" }, cadence: null },
        ],
      },
    },
    deps: {
      catalogAgentIds: () => new Set(["preset-chief", "preset-aud"]),
      resolveExisting: () => true,
      reconcile: async () => {},
      db: {
        createFleet: (f) => ({ id: f.id ?? "f_new", ...f }),
        createMember: (m) => { created.push(m); return m; },
        getFleet: () => null,
        findPostByTarget: () => null,
        findFleetByTemplate: () => null,
      },
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out.error ?? out));
  const aud = created.find((m) => m.title === "审计官");
  assert.ok(aud, "审计官岗位应被创建");
  assert.equal(aud.targetKind, "auditor", "落地后必须仍是 auditor（回落 persona 等于静默丢掉职责）");
  assert.equal(aud.targetId, "preset-aud");
});

// ── pack memory policy lands with the fleet (add-pack-memory-declaration 4.1) ─
//
// Two things must be true at the call site, and neither is about the memory
// service (which has its own tests): the landing tries, and a memory failure
// never turns a successful provision into a failure. Both are asserted with the
// `syncMemoryPolicy` seam so no network is involved.
test("provisioning lands the pack's process axis, and reports it", async () => {
  const seen = [];
  const deps = {
    ...provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) }),
    syncMemoryPolicy: async (args) => {
      seen.push(args);
      return { ok: true, action: "written", rootKey: `d-${args.packId}` };
    },
  };
  const out = await provisionFleetFromTemplate({
    packId: "pack_mem",
    version: "1.0.0",
    manifest: { ...goodManifest(), memory: { process: { distill: "off" } } },
    ownerEmail: "owner@test",
    deps,
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1, "landing must call the sync exactly once");
  assert.equal(seen[0].packId, "pack_mem");
  assert.deepEqual(seen[0].manifest.memory, { process: { distill: "off" } });
  assert.equal(seen[0].liveFleets, 1, "at least this team is live");
  assert.equal(out.memoryPolicy.action, "written", "the outcome is reported, not swallowed");
});

test("a memory failure never fails the provision", async () => {
  const deps = {
    ...provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) }),
    syncMemoryPolicy: async () => {
      throw new Error("memory service unreachable");
    },
  };
  const out = await provisionFleetFromTemplate({
    packId: "pack_memfail",
    version: "1.0.0",
    manifest: goodManifest(),
    ownerEmail: "owner@test",
    deps,
  });
  assert.equal(out.ok, true, "the team still lands");
  assert.equal(out.memoryPolicy.ok, false);
  assert.equal(out.memoryPolicy.action, "failed");
  assert.match(out.memoryPolicy.reason, /unreachable/);
});
