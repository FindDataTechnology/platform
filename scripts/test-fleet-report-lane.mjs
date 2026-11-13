// Unit tests for the fleet report lane (agent-fleet-report-lane).
//
// Covers the chain the spec pins:
//   - member_reports storage: append/latest/timeline/previous/count
//   - payload validation (lenient write) + flood window math
//   - attribution: running cluster task wins over preset, unique preset hit,
//     ambiguity rejection, non-member rejection, roster mapping
//   - trends: system-computed vs previous report, self-delta as note only,
//     no-predecessor = no trend (never faked)
//   - a2a derived execution summaries (ok text / failure / not applicable)
//   - patrol-context rendering: child slot values + blockers + overview,
//     no-children segment, per-post and total truncation marks
//   - cron fire chain: non-fleet prompt byte-identical, fleet template gets a
//     per-fire render (stored prompt stays the template), render failure fails
//     the fire explicitly (never a silent empty-context patrol)
//   - dual-window missing: execution window vs report window, evidence names
//     which window fired
//   - routes: report bridge (attribution/flood/slot echo), timeline paging,
//     detail latestReport with trends
//
// Run: node --test scripts/test-fleet-report-lane.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-report-"));
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
const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");
const {
  validateReportPayload,
  resolveAttribution,
  floodWindowMs,
  checkFlood,
  computeTrend,
  buildLatestView,
  derivedReportFromTask,
  renderFleetIdentity,
  fleetIdentityFor,
} = await import("../server/fleet-reports.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { buildFleetContext } = await import("../server/fleet-context.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

// The fake turn captures the prompt it ran with — the injection assertions
// compare against it.
const firedPrompts = [];
async function bootEngine() {
  // Boot through cron.initCron, not engine.initTaskEngine: the pre-turn seam
  // (fix-fleet-context-injection-seam) is registered there, exactly as
  // server.js boots it in production (server.js:1540). A raw engine boot leaves
  // the seam unattached, and every injection assertion would then compare
  // against a bare template.
  await cron.initCron({
    broadcast: () => {},
    runJobTurn: async (job) => {
      firedPrompts.push(job.prompt);
      return { ok: true, text: "远端答复" };
    },
    isBusy: () => false,
  });
}
await bootEngine();

test.after(async () => {
  cron.shutdown?.();
  // Drain the engine's serialized write chain BEFORE deleting the tmp root —
  // a queued jobs.json rename against a removed directory is an unhandled
  // rejection the runner flags as a suite failure.
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

function fixtureFleet(db, name = "一号舰队") {
  return db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: "owner@test" });
}

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "电商部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [{ key: "sales_week", label: "本周销售额", unit: "$" }],
    cadence: over.cadence !== undefined ? over.cadence : { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
  });
}

function fixtureReport(db, member, over = {}) {
  return db.appendReport({
    id: `r_${Math.random().toString(36).slice(2, 10)}`,
    fleetId: member.fleetId,
    memberId: member.id,
    sessionId: over.sessionId ?? null,
    metrics: over.metrics ?? { sales_week: { value: 280 } },
    resources: over.resources ?? [],
    blockers: over.blockers ?? [],
    summary: over.summary ?? "稳定",
    source: over.source ?? "self",
    createdAt: over.createdAt ?? Date.now(),
  });
}

// ── 1.1 storage ─────────────────────────────────────────────────────────────

test("member_reports: append, latest per fleet, timeline desc, previous, count", () => {
  const fleet = fixtureFleet(fleetDb);
  const m1 = fixtureMember(fleetDb, fleet.id, { id: "m_one" });
  const m2 = fixtureMember(fleetDb, fleet.id, { id: "m_two", title: "内容部", targetId: "persona-b" });

  const t0 = Date.now();
  const a = fixtureReport(fleetDb, m1, { createdAt: t0 - 3000, metrics: { sales_week: { value: 280 } } });
  fixtureReport(fleetDb, m2, { createdAt: t0 - 2000 });
  const b = fixtureReport(fleetDb, m1, { createdAt: t0 - 1000, metrics: { sales_week: { value: 309 } } });
  fixtureReport(fleetDb, m1, { createdAt: t0, source: "derived", summary: "a2a 摘要" });

  const latestByMember = fleetDb.latestReports(fleet.id);
  assert.equal(latestByMember.get("m_one").summary, "a2a 摘要", "newest wins regardless of source");
  assert.equal(latestByMember.get("m_two").summary, "稳定");

  const timeline = fleetDb.listReports("m_one", { limit: 10 });
  assert.deepEqual(timeline.map((r) => r.id), [latestByMember.get("m_one").id, b.id, a.id], "newest first");

  const prev = fleetDb.previousReport("m_one", b.createdAt);
  assert.equal(prev.id, a.id);
  assert.equal(fleetDb.previousReport("m_one", a.createdAt), null);

  // Flood counting ignores derived rows.
  assert.equal(fleetDb.countReportsSince("m_one", t0 - 60_000), 2);
});

// ── 1.2 validation + flood ──────────────────────────────────────────────────

test("validateReportPayload: summary required, lenient metrics, 8KB cap", () => {
  assert.equal(validateReportPayload({}).ok, false);
  assert.equal(validateReportPayload({ summary: "  " }).ok, false);
  const ok = validateReportPayload({
    summary: "今日 $309",
    metrics: { sales_week: { value: "$309", delta: "+12%" }, extra_undeclared: { value: 1 } },
    blockers: ["库存告急"],
    resources: [{ name: "主店铺", kind: "shop" }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.metrics.sales_week.delta, "+12%");
  assert.equal(ok.report.metrics.extra_undeclared.value, 1, "undeclared keys kept verbatim");

  assert.equal(validateReportPayload({ summary: "x", metrics: { a: { value: true } } }).ok, false);
  assert.equal(
    validateReportPayload({ summary: "x", metrics: { a: { value: "y".repeat(9 * 1024) } } }).ok,
    false,
    "8KB body cap",
  );
});

test("flood window math + rejection carries windowResetsAt", () => {
  const hourly = floodWindowMs({ cron: "0 * * * *", tz: null }, (c) => (c === "0 * * * *" ? 3600_000 : null));
  assert.equal(hourly, 1800_000);
  const daily = floodWindowMs({ cron: "0 9 * * *", tz: null }, (c) => (c === "0 9 * * *" ? 86_400_000 : null));
  assert.equal(daily, 43_200_000);
  assert.equal(floodWindowMs(null, () => null), 600_000, "floor 10min");
  assert.equal(floodWindowMs({ cron: "x", tz: null }, () => null), 600_000, "unparseable → floor");

  const now = Date.now();
  const pass = checkFlood({ countSince: 2, windowMs: 600_000, now });
  assert.equal(pass.ok, true);
  const fail = checkFlood({ countSince: 3, windowMs: 600_000, now, oldestInWindowAt: now - 60_000 });
  assert.equal(fail.ok, false);
  assert.equal(fail.windowResetsAt, now - 60_000 + 600_000, "resets one window after the oldest in-window report");
});

// ── 1.3 attribution ─────────────────────────────────────────────────────────

test("attribution: running cluster task wins; preset resolves uniquely; ambiguity and none rejected", () => {
  const m = fixtureMember(fleetDb, fixtureFleet(fleetDb).id, { targetId: "Persona_A" });
  const roster = (id) => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

  // Cluster fire running → its post, even though a persona post would also
  // match the live preset (the fan-out rotates presets — that match is a lie).
  const clusterTask = { state: "running", targetType: "cluster", sourceTag: { fleetId: m.fleetId, memberId: "m_cluster" } };
  const hit = resolveAttribution({
    currentPreset: "persona-a",
    runningTasks: [clusterTask],
    personaMembers: [m],
    rosterPresetId: roster,
  });
  assert.equal(hit.kind, "cluster-task");
  assert.equal(hit.memberId, "m_cluster");

  const preset = resolveAttribution({ currentPreset: "persona-a", runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(preset.kind, "preset");
  assert.equal(preset.memberId, m.id, "roster mapping resolves the catalog id");

  const twin = fixtureMember(fleetDb, m.fleetId, { title: "影子岗", targetId: "persona-a" });
  const ambiguous = resolveAttribution({ currentPreset: "persona-a", runningTasks: [], personaMembers: [m, twin], rosterPresetId: roster });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.match(ambiguous.error, /several posts/);

  const none = resolveAttribution({ currentPreset: "stranger", runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(none.kind, "none");
  const noPreset = resolveAttribution({ currentPreset: null, runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(noPreset.kind, "none");
});

// ── 1.3b attribution under persona parking (fix-parked-preset-attribution) ──
//
// The 2026-10-31 production regression: `add-cell-session-persona` parks the
// persona on the SESSION and deliberately leaves the runtime's deployment
// default preset alone, so attribution that reads `ctx.currentPreset` resolves
// the WRONG persona (or none) and every fleet post's report_status 409s
// ("not a member of any fleet"). Live evidence: both cells' self reports
// dropped to zero right after the first parked event (28 + 12 in the prior
// 6h, 0 after). These cases pin the replacement signals.

test("attribution: in-flight turn wins over the deployment default (parked round)", () => {
  const m = fixtureMember(fleetDb, fixtureFleet(fleetDb).id, { targetId: "ob-scout" });
  // The cell's deployment default is some OTHER persona — exactly what a
  // parked round leaves behind.
  const hit = resolveAttribution({
    currentPreset: "fleet-architect",
    openTurns: [{ fleetId: m.fleetId, memberId: m.id, turnId: "turn_1" }],
    runningTasks: [],
    personaMembers: [m],
  });
  assert.equal(hit.kind, "turn", "the in-flight turn names the post, not the runtime default");
  assert.equal(hit.memberId, m.id);
  assert.equal(hit.fleetId, m.fleetId);

  // Without the ledger entry (degrade-open) the running task's sourceTag still
  // names the post — this is what keeps a parked round attributable.
  const viaTask = resolveAttribution({
    currentPreset: "fleet-architect",
    openTurns: [],
    runningTasks: [{ state: "running", targetType: "persona", sourceTag: { fleetId: m.fleetId, memberId: m.id } }],
    personaMembers: [m],
  });
  assert.equal(viaTask.kind, "job-sourceTag");
  assert.equal(viaTask.memberId, m.id);
});

test("attribution: several turns in flight is not guessed", () => {
  const m = fixtureMember(fleetDb, fixtureFleet(fleetDb).id, { targetId: "ob-scout" });
  const twin = fixtureMember(fleetDb, m.fleetId, { title: "建模岗", targetId: "ob-modeler" });
  const many = resolveAttribution({
    currentPreset: "fleet-architect",
    openTurns: [
      { fleetId: m.fleetId, memberId: m.id, turnId: "turn_1" },
      { fleetId: m.fleetId, memberId: twin.id, turnId: "turn_2" },
    ],
    runningTasks: [],
    personaMembers: [m, twin],
  });
  assert.notEqual(many.kind, "turn", "no single post owns the call");
  assert.equal(many.kind, "none", "the deployment default matches no post → honest rejection, never a guess");
});

test("attribution: chat lane (no in-flight turn) still resolves by live preset", () => {
  const m = fixtureMember(fleetDb, fixtureFleet(fleetDb).id, { targetId: "Persona_A" });
  const roster = (id) => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const chat = resolveAttribution({
    currentPreset: "persona-a",
    openTurns: [],
    runningTasks: [],
    personaMembers: [m],
    rosterPresetId: roster,
  });
  assert.equal(chat.kind, "preset", "zero-change for the conversation lane");
  assert.equal(chat.memberId, m.id);
});

// ── trends + views ──────────────────────────────────────────────────────────

test("trends: system-computed; self-delta is a note; no predecessor = null", () => {
  assert.deepEqual(computeTrend({ value: 309 }, { value: 280 }), { direction: "up", deltaValue: 29 });
  assert.deepEqual(computeTrend({ value: 280 }, { value: 309 }), { direction: "down", deltaValue: -29 });
  assert.deepEqual(computeTrend({ value: "280" }, { value: 280 }), { direction: "flat", deltaValue: 0 }, "numeric strings compare numerically");
  assert.deepEqual(computeTrend({ value: "beta" }, { value: "alpha" }), { direction: "changed", deltaValue: null });
  assert.equal(computeTrend({ value: 1 }, undefined), null);

  const member = { kpiSlots: [{ key: "sales_week", label: "本周销售额", unit: "$" }, { key: "stars", label: "星数" }] };
  const view = buildLatestView({
    report: {
      createdAt: 2,
      summary: "涨了",
      source: "self",
      sessionId: "s1",
      metrics: { sales_week: { value: 309, delta: "+1%" }, stars: { value: 47 }, undeclared: { value: "x" } },
      blockers: [],
    },
    previous: { metrics: { sales_week: { value: 280 }, stars: { value: 47 } } },
    kpiSlots: member.kpiSlots,
  });
  const sales = view.slots.find((s) => s.key === "sales_week");
  assert.equal(sales.trend.direction, "up");
  assert.equal(sales.trend.deltaValue, 29);
  assert.equal(sales.note, "+1%", "self-delta rides as note only");
  assert.deepEqual(view.slots.find((s) => s.key === "stars").trend, { direction: "flat", deltaValue: 0 });
  assert.deepEqual(view.undeclaredKeys, ["undeclared"], "undeclared keys surface for the detail view");
  assert.equal(view.metricsAll.undeclared.value, "x");

  const firstEver = buildLatestView({
    report: { createdAt: 1, summary: "首次", source: "self", sessionId: null, metrics: { sales_week: { value: 10 } }, blockers: [] },
    previous: null,
    kpiSlots: member.kpiSlots,
  });
  assert.equal(firstEver.slots.find((s) => s.key === "sales_week").trend, null, "无前值不伪造");
});

// ── a2a derived summaries ───────────────────────────────────────────────────

test("derivedReportFromTask: a2a fires only, text or failure become the summary", () => {
  const task = {
    sourceTag: { fleetId: "f", memberId: "m" },
    targetType: "a2a",
    sessionId: "cron-x",
    history: [{ time: "2026-10-23T00:00:00.000Z", success: true, text: "外部服务答复正文" }],
  };
  const derived = derivedReportFromTask(task, { now: 1 });
  assert.equal(derived.source, "derived");
  assert.equal(derived.summary, "外部服务答复正文");
  assert.equal(derived.sessionId, "cron-x");

  const failed = derivedReportFromTask({
    ...task,
    history: [{ time: "2026-10-23T00:00:00.000Z", success: false, error: "502" }],
  }, { now: 1 });
  assert.match(failed.summary, /执行失败/);
  assert.deepEqual(failed.blockers, ["502"]);

  assert.equal(derivedReportFromTask({ ...task, targetType: "persona" }), null);
  assert.equal(derivedReportFromTask({ ...task, sourceTag: null }), null);
  assert.equal(derivedReportFromTask({ ...task, history: [] }), null);
});

// ── patrol context ──────────────────────────────────────────────────────────

function contextDeps(db, statuses) {
  return {
    db,
    deriveStatuses: () => new Map(Object.entries(statuses ?? { x: "on_duty" })),
    decisionDigest: null,
  };
}

test("fleet-context: renders child slots, blockers, overview; no-children segment", async () => {
  const fleet = fixtureFleet(fleetDb, "试验舰队");
  const _ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo", title: "CEO", targetId: "persona-ceo", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const shop = fixtureMember(fleetDb, fleet.id, { id: "m_shop", title: "电商部", parentId: "m_ceo", targetId: "persona-shop" });
  fixtureMember(fleetDb, fleet.id, { id: "m_far", title: "孙岗", parentId: "m_shop", targetId: "persona-far" }); // grandchild — NOT direct
  fixtureReport(fleetDb, shop, { metrics: { sales_week: { value: "$309" } }, blockers: ["库存告急"], summary: "今日大促" });
  fixtureReport(fleetDb, fleetDb.getMember("m_far"), { summary: "孙岗报数", metrics: {} });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo" }, {}, contextDeps(fleetDb));
  assert.match(text, /【集群巡视上下文】集群「试验舰队」在岗 1\/3/);
  assert.match(text, /### 电商部/);
  assert.match(text, /本周销售额（\$）: \$309/);
  assert.match(text, /库存告急/);
  assert.match(text, /今日大促/);
  // fix-fleet-descendant-reports MOVED this contract: the grandchild used to be
  // invisible (the hierarchy relay was the only channel and no tool read other
  // posts' reports). It still must not render as a DIRECT-child block — its
  // material arrives in the separate, clearly-labelled deeper segment.
  assert.ok(!/### 孙岗\n/.test(text), "not as a direct-child block");
  assert.match(text, /【更深层报数（直接下级的下级及以下）】/);
  assert.match(text, /### 孙岗（第 2 层｜CEO > 电商部）/, "but present, labelled with its layer and path");
  assert.match(text, /孙岗报数/, "with its latest report");

  const _lonely = fixtureMember(fleetDb, fleet.id, { id: "m_solo", title: "独立岗", targetId: "persona-solo", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const soloText = await buildFleetContext({ fleetId: fleet.id, memberId: "m_solo" }, {}, contextDeps(fleetDb));
  assert.match(soloText, /本岗位无直接下级/);
});

// fix-fleet-chain-operability D2: the post's OWN block carries its declared
// KPI slot keys — report_status marks invented keys UNRECOGNIZED and nothing
// else revealed the declared face (live 2026-10-31: all five ontology-fleet
// posts invented keys; the reviewer escalated the invisibility).
test("fleet-context: own block lists declared KPI slot keys verbatim", async () => {
  const fleet = fixtureFleet(fleetDb, "槽位舰队");
  fixtureMember(fleetDb, fleet.id, {
    id: "m_gate",
    title: "纪律校验闸",
    targetId: "persona-gate",
    kpiSlots: [
      { key: "passed", label: "过闸", unit: "份" },
      { key: "blocked", label: "拦截", unit: "份" },
    ],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "校验 {{fleetContext}}", enabled: true },
  });
  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_gate" }, {}, contextDeps(fleetDb));
  assert.match(text, /本岗声明的报数槽位/);
  assert.match(text, /passed（过闸\/份）/);
  assert.match(text, /blocked（拦截\/份）/);
  assert.match(text, /report_status 的 metrics 键就用这些/);

  // A post with no declared slots gets no line (never an empty placeholder).
  fixtureMember(fleetDb, fixtureFleet(fleetDb, "裸舰队").id, {
    id: "m_bare",
    title: "裸岗",
    targetId: "persona-bare",
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true },
  });
  const bare = await buildFleetContext({ fleetId: fixtureFleet(fleetDb, "裸舰队").id, memberId: "m_bare" }, {}, contextDeps(fleetDb));
  assert.ok(!bare.includes("本岗声明的报数槽位"), "no declared slots ⇒ no line");
});

test("fleet-context: per-post 4KB and total 24KB truncation marks; dead fleet throws", async () => {
  const fleet = fixtureFleet(fleetDb);
  const _ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo2", title: "CEO", targetId: "persona-ceo2", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x {{fleetContext}}", enabled: true } });

  // A maximal child post: 8 declared slots × 300-char values + 20 blockers —
  // the inner caps themselves allow >4KB, so the per-post guard cuts.
  const fatSlots = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `槽${i}` }));
  const fat = fixtureMember(fleetDb, fleet.id, { title: "话痨岗", parentId: "m_ceo2", targetId: "persona-x", kpiSlots: fatSlots });
  const fatMetrics = Object.fromEntries(fatSlots.map((s) => [s.key, { value: "v".repeat(300) }]));
  fixtureReport(fleetDb, fat, { summary: "多", metrics: fatMetrics, blockers: Array.from({ length: 20 }, (_, i) => `b${i}-${"x".repeat(110)}`) });
  const oneChild = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo2" }, {}, contextDeps(fleetDb));
  assert.match(oneChild, /…\[截断\]/, "per-post 4KB cap marks the cut");

  // Several fat children exceed the 24KB total → the tail is marked.
  for (let i = 0; i < 12; i++) {
    const c = fixtureMember(fleetDb, fleet.id, { title: `岗${i}`, parentId: "m_ceo2", targetId: `persona-t${i}`, kpiSlots: fatSlots });
    fixtureReport(fleetDb, c, { summary: "多", metrics: fatMetrics, blockers: [] });
  }
  const big = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo2" }, {}, contextDeps(fleetDb));
  assert.match(big, /总量上限截断/);
  assert.ok(big.length < 26 * 1024, "hard ceiling holds");

  await assert.rejects(
    () => buildFleetContext({ fleetId: "fleet_nope", memberId: "x" }, {}, contextDeps(fleetDb)),
    /no longer exists/,
  );
});

// ── cron fire chain (2.1–2.3) ───────────────────────────────────────────────

test("fire chain: non-fleet prompt byte-identical; fleet template renders per fire", async () => {
  cron.setFleetContextRenderer(null);
  firedPrompts.length = 0;

  const plain = await cron.addJob({ cron: "0 3 1 1 *", prompt: "静态巡视 {{fleetContext}}", preset: "p" });
  await cron.fireTask(plain.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "静态巡视 {{fleetContext}}", "no sourceTag → placeholder untouched, byte-for-byte");

  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-fire" });
  const spec = {
    cron: "0 3 1 1 *",
    prompt: "巡视下属。{{fleetContext}}",
    sessionTitle: "巡视",
    preset: "persona-fire",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  };
  const task = await cron.addJob(spec);
  cron.setFleetContextRenderer(async () => "【集群巡视上下文】在岗 3/3");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "巡视下属。【集群巡视上下文】在岗 3/3");
  // The STORED prompt stays the template — the render was per-fire only.
  assert.equal(cron.getJob(task.id).prompt, "巡视下属。{{fleetContext}}");

  // Re-render on the next fire (fresh context each time).
  cron.setFleetContextRenderer(async () => "第二帧上下文");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "巡视下属。第二帧上下文");
});

test("fire chain: render failure fails the fire explicitly, nothing enqueues", async () => {
  firedPrompts.length = 0;
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-boom" });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-boom",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  cron.setFleetContextRenderer(async () => {
    throw new Error("db exploded");
  });
  await cron.fireTask(task.id);
  await engine.idle();
  const after = cron.getJob(task.id);
  assert.equal(after.state, "failed");
  assert.match(after.history.at(-1).error, /fleetContext render failed: db exploded/);
  assert.equal(firedPrompts.length, 0, "no turn ran — never a silent empty-context patrol");

  // A renderer that returns an empty segment is equally fatal.
  await engine.runTaskNow(task.id); // reset lifecycle via the re-run path
  await engine.idle();
  firedPrompts.length = 0;
  cron.setFleetContextRenderer(async () => "   ");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.length, 0);
  assert.match(cron.getJob(task.id).history.at(-1).error, /empty segment/);

  cron.setFleetContextRenderer(null);
});

// ── dual-window missing (3.4) ───────────────────────────────────────────────

test("derive: report window fires when executions are healthy", () => {
  const fleet = { state: "active" };
  const cadence = { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true }; // window 6h
  const now = Date.now();
  const freshTask = {
    lastRun: new Date(now - 1800_000).toISOString(),
    createdAt: new Date(now - 7200_000).toISOString(),
  };

  const healthy = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: { createdAt: now - 1800_000 }, now });
  assert.equal(healthy.status, "on_duty");
  assert.equal(healthy.evidence.hitWindow, null);

  const reportStale = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: { createdAt: now - 7 * 3600_000 }, now });
  assert.equal(reportStale.status, "missing");
  assert.equal(reportStale.evidence.hitWindow, "report");
  assert.match(reportStale.reason, /no report/);

  // Never reported → the report window does not fire (nothing to go stale).
  const neverReported = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: null, now });
  assert.equal(neverReported.status, "on_duty");

  const execStale = deriveMemberStatus({
    member: { cadence }, fleet,
    task: { lastRun: new Date(now - 8 * 3600_000).toISOString(), createdAt: new Date(now - 8200_000).toISOString() },
    targetAlive: true,
    latestReport: { createdAt: now - 1800_000 },
    now,
  });
  assert.equal(execStale.status, "missing");
  assert.equal(execStale.evidence.hitWindow, "execution");
});

// ── routes (3.1) ────────────────────────────────────────────────────────────

async function startServer(ctx) {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

test("routes: report bridge attribution, slot echo, flood, timeline, detail latest", async () => {
  const universe = { "persona-a": { name: "甲" }, "persona-b": { name: "乙" } };
  const fleet = fixtureFleet(fleetDb, "报数舰队");
  const member = fixtureMember(fleetDb, fleet.id, { title: "电商部" });
  // A live conversation pointer — the manual-turn source session.
  chatHistory.setSessionManager({ getSessionId: () => "sess-live" });
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
  });

  try {
    // Baseline report: accepted + unrecognized keys echoed.
    const r1 = await call("POST", "/api/fleets/report", {
      summary: "第一轮 $280",
      metrics: { sales_week: { value: 280 }, typo_key: { value: "x" } },
    });
    assert.equal(r1.status, 201);
    assert.deepEqual(r1.body.slotsAccepted, ["sales_week"]);
    assert.deepEqual(r1.body.slotsUnrecognized, ["typo_key"]);
    assert.equal(r1.body.memberTitle, "电商部");

    // Second report: trend-able predecessor.
    const r2 = await call("POST", "/api/fleets/report", {
      summary: "第二轮 $309",
      metrics: { sales_week: { value: 309, delta: "+1%" } },
    });
    assert.equal(r2.status, 201);

    // Flood: window = max(30min, 10min); third passes, fourth rejects.
    const r3 = await call("POST", "/api/fleets/report", { summary: "第三轮", metrics: { sales_week: { value: 315 } } });
    assert.equal(r3.status, 201);
    const r4 = await call("POST", "/api/fleets/report", { summary: "第四轮", metrics: {} });
    assert.equal(r4.status, 429);
    assert.ok(r4.body.windowResetsAt > Date.now());
    assert.equal(fleetDb.listReports(member.id).length, 3, "rejected call left nothing behind");

    // Non-member (preset with no post) → 409.
    const stranger = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: "persona-zz",
      fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
    });
    const r409 = await stranger.call("POST", "/api/fleets/report", { summary: "x" });
    assert.equal(r409.status, 409);
    assert.match(r409.body.error, /not a member/);
    stranger.server.close();

    // Timeline endpoint: desc + paging via nextBefore.
    const page1 = await call("GET", `/api/fleets/${fleet.id}/members/${member.id}/reports?limit=2`);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.reports.length, 2);
    assert.ok(page1.body.reports[0].at >= page1.body.reports[1].at);
    assert.ok(page1.body.nextBefore);
    const page2 = await call("GET", `/api/fleets/${fleet.id}/members/${member.id}/reports?limit=2&before=${page1.body.nextBefore}`);
    assert.equal(page2.body.reports.length, 1);
    assert.equal(page2.body.nextBefore, null);

    // Detail: latestReport with system trend + timeline preview + evidence.
    const detail = await call("GET", `/api/fleets/${fleet.id}`);
    assert.equal(detail.status, 200);
    const view = detail.body.members.find((m) => m.id === member.id);
    assert.equal(view.latestReport.source, "self");
    const slot = view.latestReport.slots.find((s) => s.key === "sales_week");
    assert.equal(slot.trend.direction, "up");
    assert.equal(slot.trend.deltaValue, 6, "trend vs the previous report (309 → 315)");
    assert.equal(slot.note, null);
    assert.equal(view.reportTimeline.length, 3);
    assert.equal(view.reportTimeline[0].sessionId, "sess-live", "timeline rows carry the source session");
    assert.equal(view.evidence.latestReportAt != null, true);
  } finally {
    server.close();
  }
});

// ── enable-wire-content-fleet: post identity + cadence read ─────────────────

test("renderFleetIdentity: four fields, credential-free", () => {
  const line = renderFleetIdentity({
    fleetId: "f_1",
    memberId: "m_1",
    title: "巡线岗",
    targetKind: "persona",
    targetId: "persona-a",
  });
  assert.match(line, /fleet=f_1/);
  assert.match(line, /post=m_1/);
  assert.match(line, /title=巡线岗/);
  assert.match(line, /target=persona:persona-a/);
  assert.ok(!/token|key|secret|Bearer/i.test(line), "identity carries no credential");
});

test("routes: ghost posts of archived fleets exit attribution (0030e1e8 family)", async () => {
  // A persona swapped into a DISSOLVED fleet's post keeps a member row. That
  // ghost must not collide with its live post: report attribution (and the
  // same candidate set escalate rides) resolves to the LIVE post alone.
  const universe = { "persona-a": { name: "甲" } };
  const live = fixtureFleet(fleetDb, "活舰队");
  const livePost = fixtureMember(fleetDb, live.id, { title: "真岗", kpiSlots: [{ key: "risk_flags", label: "风险提示" }] });
  const ghostFleet = fixtureFleet(fleetDb, "已解散舰队");
  fixtureMember(fleetDb, ghostFleet.id, { title: "幽灵岗", targetId: "persona-a" });
  fleetDb.updateFleet(ghostFleet.id, { state: "archived" });

  chatHistory.setSessionManager({ getSessionId: () => "sess-ghost" });
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
  });
  try {
    const r = await call("POST", "/api/fleets/report", {
      summary: "幽灵岗不应造成歧义",
      metrics: { risk_flags: { value: 6 } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.memberTitle, "真岗");
    assert.deepEqual(r.body.slotsAccepted, ["risk_flags"]);
    assert.equal(fleetDb.listReports(livePost.id).length, 1);
  } finally {
    server.close();
  }
});

// A ctx whose stub bridge closes the turn immediately — enough to drive the
// REAL runPersonaTurn and inspect the prompt it dispatched.
function identityCtx(resolveFleetIdentity) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    switchPresetTo: async () => ({ ok: true }),
    // A job carrying a fleet tag may NOT skip model normalization: with no plan
    // the round is refused ("post model resolution unavailable", cron-runner
    // 872-878) because three live rounds once settled `ok` with `model=null`
    // after the catalog fetch failed (ledger E28). The harness predates that
    // rule, so it supplies the minimum plan a member post really has.
    resolveFleetModel: async (preset) => ({
      memberId: "m_1",
      preset,
      candidates: [{ model: "harness-model" }],
      notices: [],
      explicitChain: false,
    }),
    switchModelTo: async () => ({ ok: true }),
    recordFleetModelNotices: () => {},
    resolveFleetIdentity,
    prompts: [],
    dshBridge: {
      isReady: () => true,
      prompt: async (sessionId, blocks) => {
        ctx.prompts.push(blocks[0].text);
        ctx.sessionCollectors.get(sessionId)?.({ method: "session.status", params: { status: "idle" } });
      },
    },
  };
  attachCronRunner(ctx);
  return ctx;
}

test("member turn gets the identity prefix; non-member turn is byte-identical", async () => {
  const identity = "【集群岗位身份】fleet=f_1; post=m_1; title=巡线岗; target=persona:persona-a";
  // The real resolver renders the turn segment from the option its caller
  // hands in; the stub mirrors renderFleetIdentity's contract exactly.
  const render = (turn) => (turn ? `${identity}; turn=${turn}` : identity);

  const memberCtx = identityCtx((p, { turn } = {}) => (p === "persona-a" ? render(turn) : null));
  await memberCtx.runCronJobTurn(
    { id: "job_m", sessionId: "sess_m", prompt: "巡视一下", preset: "persona-a", sessionTitle: "岗" },
    { turnTimeoutMs: 2000 },
  );
  // A manual/dispatch-shaped job (no sourceTag.fleetId) lands its stable
  // session id as the turn segment — add-fleet-identity-turn 1.3.
  assert.equal(memberCtx.prompts[0], `${render("sess_m")}\n\n巡视一下`, "identity prefixes the dispatched prompt, turn = landed session id");
  const hist = await chatHistory.getSession("sess_m");
  assert.equal(hist.messages[0].content, `${render("sess_m")}\n\n巡视一下`, "session history keeps the same line");

  // Non-member (resolver returns null) — the delegation/manual lane and plain
  // persona turns both land here; prompt must not be touched.
  const plainCtx = identityCtx(() => null);
  await plainCtx.runCronJobTurn(
    { id: "job_p", sessionId: "sess_p", prompt: "随便聊聊", preset: "persona-a", sessionTitle: "聊" },
    { turnTimeoutMs: 2000 },
  );
  assert.equal(plainCtx.prompts[0], "随便聊聊", "non-member turn unchanged");
});

test("identity turn segment follows the round: two cadence rounds carry distinct landed ids", async () => {
  const identity = "【集群岗位身份】fleet=f_1; post=m_1; title=巡线岗; target=persona:persona-a";
  const seen = [];
  const memberCtx = identityCtx((p, { turn } = {}) => {
    if (p !== "persona-a") return null;
    seen.push(turn);
    return turn ? `${identity}; turn=${turn}` : identity;
  });
  const job = {
    id: "job_f", sessionId: "cron-job_f", prompt: "巡视", preset: "persona-a",
    targetType: "persona", sourceTag: { fleetId: "f_1", memberId: "m_1" },
  };
  await memberCtx.runCronJobTurn(job, { turnTimeoutMs: 2000 });
  await memberCtx.runCronJobTurn(job, { turnTimeoutMs: 2000 });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "each round's turn id is its own (per-round rotation)");
  assert.match(seen[0], /^cron-job_f#r/, "cadence rounds land the rotated child id");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(memberCtx.prompts[0], new RegExp(`turn=${esc(seen[0])}`), "round 1's prompt names the id it was dispatched under");
  assert.match(memberCtx.prompts[1], new RegExp(`turn=${esc(seen[1])}`), "round 2's prompt names the id it was dispatched under");
});

test("cadence read contract: rhythm + target only, passive post answers null", async () => {
  const fleet = fixtureFleet(fleetDb, "节奏舰队");
  const active = fixtureMember(fleetDb, fleet.id, {
    id: "m_active",
    title: "巡线岗",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "巡视", enabled: true },
  });
  fixtureMember(fleetDb, fleet.id, {
    id: "m_passive",
    title: "内容岗",
    cadence: null,
    kpiSlots: [{ key: "secret_slot", label: "不该出现" }],
  });

  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId, clusterName: null }),
  });
  try {
    const r = await call("GET", `/api/fleets/${fleet.id}/cadence`);
    assert.equal(r.status, 200);
    assert.equal(r.body.fleetName, "节奏舰队");
    const byRef = Object.fromEntries(r.body.posts.map((p) => [p.ref, p]));
    assert.deepEqual(byRef[active.id], {
      ref: "m_active",
      title: "巡线岗",
      cron: "0 9 * * *",
      tz: "Asia/Shanghai",
      targetRef: { kind: "persona", id: "persona-a" },
    });
    assert.equal(byRef.m_passive.cron, null, "passive post answers null cron");
    assert.equal(byRef.m_passive.tz, null);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("secret_slot"), "KPI slots never leave the fleet");
    assert.ok(!raw.includes("kpi"), "no KPI surface in the read contract");

    const missing = await call("GET", "/api/fleets/nope/cadence");
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("fleetIdentityFor: unique post resolves; no post and ambiguity yield null", () => {
  const fleet = fixtureFleet(fleetDb, "身份舰队");
  const post = fixtureMember(fleetDb, fleet.id, { id: "m_id1", title: "巡线岗", targetId: "persona-a" });

  const line = fleetIdentityFor(fleetDb, "persona-a");
  assert.equal(line, renderFleetIdentity({
    fleetId: fleet.id, memberId: post.id, title: "巡线岗", targetKind: "persona", targetId: "persona-a",
  }));

  // add-fleet-identity-turn: the turn option rides through verbatim; callers
  // that hand none keep the byte-identical four-field line.
  assert.equal(
    fleetIdentityFor(fleetDb, "persona-a", { turn: "cron-f1#r1761" }),
    `${line}; turn=cron-f1#r1761`,
  );

  assert.equal(fleetIdentityFor(fleetDb, "persona-zz"), null, "no post → null");
  assert.equal(fleetIdentityFor(fleetDb, null), null, "no preset → null");

  // A second post on the SAME persona makes attribution ambiguous → null.
  fixtureMember(fleetDb, fleet.id, { id: "m_id2", title: "内容岗", targetId: "persona-a" });
  assert.equal(fleetIdentityFor(fleetDb, "persona-a"), null, "ambiguous → null");
});

// ── 巡逻纪律注入（2026-10-29 §15.88 真机诊断） ──────────────────────────────
//
// 真机：CEO 岗约每 6 轮有 1 轮 `turn_budget_exceeded` 且零产出——13 步里 10 步
// 在翻工作区（read×5/glob/bash/grep），一次 report_status 都没调，因为工作区
// 躺着一份 56KB 的自写历史巡视记录（40+ 轮），每读一次就把后续每一步拖慢。
// 纪律由平台侧注入（不改任何存量岗位提示词），必须出现在每个巡逻上下文末尾。
test("fleet-context: 每份巡逻上下文都带纪律——注入即全部输入、先报数、别翻工作区", async () => {
  const fleet = fixtureFleet(fleetDb, "纪律舰队");
  const _ceo = fixtureMember(fleetDb, fleet.id, { id: "m_dc", title: "CEO", targetId: "persona-dc", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const child = fixtureMember(fleetDb, fleet.id, { id: "m_dc_shop", title: "电商部", parentId: "m_dc", targetId: "persona-dcs" });
  fixtureReport(fleetDb, child, { metrics: {}, summary: "正常" });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_dc" }, {}, contextDeps(fleetDb));
  assert.match(text, /本轮怎么干（巡逻纪律）/, "纪律段必须在");
  assert.match(text, /就是本轮的完整输入/, "钉住「注入即全部输入」");
  assert.match(text, /不要再去工作区、记忆或历史文件里找/, "钉住「别翻工作区」");
  assert.match(text, /先报数再补充/, "钉住「先报数」");
  assert.match(text, /空手超时是最差结局/, "钉住「宁可报无新数据也不要空手」");
  assert.match(text, /dispatch_post/, "追问走 dispatch_post 而不是翻文件");
  // 纪律在上下文之后（模型读到的最后一段），不是被埋在报数中间
  assert.ok(text.lastIndexOf("巡逻纪律") > text.lastIndexOf("### 电商部"), "纪律排在报数之后");

  // 无下级的孤立岗同样要拿到纪律——它们最容易「没事干就去翻文件」
  const _solo = fixtureMember(fleetDb, fleet.id, { id: "m_dc_solo", title: "独立岗", targetId: "persona-dcsolo", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const soloText = await buildFleetContext({ fleetId: fleet.id, memberId: "m_dc_solo" }, {}, contextDeps(fleetDb));
  assert.match(soloText, /本轮怎么干（巡逻纪律）/, "孤立岗也带纪律");
});

// ── 手动戳发也走同一条注入路径（2026-10-29 真机取证） ──────────────────────
//
// 真机发现：`POST /api/cron/:id/run`（人点「立即执行」/走查触发）走的是
// cron.runJobNow → engine.runTaskNow → enqueueExecution，**完全绕过 fireTask**，
// 于是 `{{fleetContext}}` 从不被展开——CEO 那轮拿到的 prompt 只有 249 字符
// （正常轮 2880），既没有巡视上下文也没有纪律。这既让手动走查失真，也让被
// 手动触发的代理因为「没上下文」而四处翻文件——与 §15.88 的空转同源。
test("fire chain: 手动戳发同样注入 fleetContext（与定时开火同一条路）", async () => {
  firedPrompts.length = 0;
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-manual" });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视下属。{{fleetContext}}",
    preset: "persona-manual",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });

  cron.setFleetContextRenderer(async () => "手动帧上下文");
  const r = await cron.runJobNow(task.id);
  await engine.idle();
  assert.equal(r?.ok, true, "手动戳发要成功");
  assert.equal(
    firedPrompts[firedPrompts.length - 1],
    "巡视下属。手动帧上下文",
    "手动触发必须展开占位符，不能把裸模板喂给代理",
  );
  // 存着的仍是模板
  assert.equal(cron.getJob(task.id).prompt, "巡视下属。{{fleetContext}}");
});

test("fire chain: 手动戳发遇到渲染失败时明确失败，不静默跑裸模板", async () => {
  firedPrompts.length = 0;
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-manual-fail" });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-manual-fail",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  cron.setFleetContextRenderer(async () => "");   // 空段
  // fix-fleet-context-injection-seam 语义迁移：渲染失败从「入队前同步拒绝」
  // 改为「起轮时缝内失败、落史」——runJobNow 收到的是入队回执（ok=true =
  // 已受理），失败在同一任务的历史里以结构化错误呈现。spec 口径不变：
  // 该次触发显性失败，绝不静默按裸模板跑一轮。
  const r = await cron.runJobNow(task.id);
  await engine.idle();
  assert.equal(r?.ok, true, "手动戳发的入队回执（失败在执行落史，不在受理）");
  const after = cron.getJob(task.id);
  assert.equal(after.state, "failed", "该次执行以失败结算");
  assert.match(String(after.history.at(-1)?.error ?? ""), /empty segment/, "结构化错误落史");
  assert.equal(firedPrompts.length, 0, "没有 turn 真正起跑——绝不裸模板执行");
  assert.ok(
    !firedPrompts.some((p) => p === "巡视 {{fleetContext}}" || p === "巡视 "),
    "绝不能拿裸模板或无上下文 prompt 跑这一轮",
  );
});

// ── 岗位自身轮次上下文（add-fleet-self-round-context） ─────────────────────
//
// 每轮都是全新会话（fix-fleet-round-discipline D4/D7 刻意轮换 child session
// id：稳定 id 5 轮涨 2.3MB，压缩吃光 600s 预算）。无状态是对的，但它让岗位
// 看不到自己上一轮说了什么——于是岗位自建土办法：把每轮写进工作区文件再读
// 回来（ceo-patrol-round4.md，40+ 轮 56KB，光读它就烧光预算）。平台因此直接
// 把岗位自己的最近几轮交给它，有界：每轮一条摘要，绝不喂整轮助手文本。
import { pickSelfRounds, renderSelfBlock, renderExecutionHealth } from "../server/fleet-context.js";

test("pickSelfRounds: 一轮多次报数只算一轮（按 session 归并，不按条数）", () => {
  // 同一轮内三次 report_status —— 朴素取「最近 3 条」会得到三轮全是同一轮。
  const reports = [
    { sessionId: "s1", createdAt: 300, summary: "第三报", metrics: {}, blockers: [] },
    { sessionId: "s1", createdAt: 200, summary: "第二报", metrics: {}, blockers: [] },
    { sessionId: "s1", createdAt: 100, summary: "第一报", metrics: {}, blockers: [] },
    { sessionId: "s2", createdAt: 90, summary: "上轮", metrics: {}, blockers: [] },
    { sessionId: "s3", createdAt: 80, summary: "上上轮", metrics: {}, blockers: [] },
  ];
  const rounds = pickSelfRounds(reports);
  assert.equal(rounds.length, 3, "三个不同轮次");
  assert.deepEqual(rounds.map((r) => r.sessionId), ["s1", "s2", "s3"], "时间倒序且按 session 去重");
  assert.equal(rounds[0].reports.length, 3, "s1 轮内的三条都归在这一轮");
});

test("pickSelfRounds: sessionId 全空时按时间就近归并，不虚增轮数", () => {
  const t0 = 1_000_000;
  const reports = [
    { sessionId: null, createdAt: t0 + 5_000, summary: "同轮A", metrics: {}, blockers: [] },
    { sessionId: null, createdAt: t0 + 1_000, summary: "同轮B", metrics: {}, blockers: [] },
    // 远超 10 分钟窗口 → 另一轮
    { sessionId: null, createdAt: t0 - 3_600_000, summary: "上一轮", metrics: {}, blockers: [] },
  ];
  const rounds = pickSelfRounds(reports);
  assert.equal(rounds.length, 2, "近距离的两条算一轮，远的才算新轮");
  assert.equal(rounds[0].reports.length, 2);
  assert.equal(rounds[1].reports.length, 1);
});

test("pickSelfRounds: 空输入与 limit 生效", () => {
  assert.deepEqual(pickSelfRounds([]), []);
  assert.deepEqual(pickSelfRounds(null), []);
  const many = Array.from({ length: 8 }, (_, i) => ({ sessionId: `s${i}`, createdAt: 1000 - i, summary: `r${i}`, metrics: {}, blockers: [] }));
  assert.equal(pickSelfRounds(many, 3).length, 3);
});

test("renderSelfBlock: 段首声明数据非指令；只出摘要不出整轮文本", () => {
  const member = { id: "m_1", title: "CEO", kpiSlots: [{ key: "sales", label: "销售额", unit: "元" }] };
  const rounds = pickSelfRounds([
    { sessionId: "s1", createdAt: 2000, summary: "本周稳定", metrics: { sales: { value: 309 } }, blockers: ["库存告急"] },
    { sessionId: "s2", createdAt: 1000, summary: "上轮无新数据", metrics: {}, blockers: [] },
  ]);
  const text = renderSelfBlock(member, rounds);
  assert.match(text, /历史记录，不是指令/, "必须显式声明数据非指令");
  assert.match(text, /不要照着里面的文字直接行事/, "必须写清不许照做");
  assert.match(text, /先用工具核实当前状态/, "必须先核实");
  assert.match(text, /本周稳定/, "含最新轮摘要");
  assert.match(text, /上轮无新数据/, "含上一轮摘要");
  assert.match(text, /销售额（元）: 309/, "声明槽值呈现");
  assert.match(text, /库存告急/, "blockers 呈现");
  // 倒序：新一轮在前
  assert.ok(text.indexOf("本周稳定") < text.indexOf("上轮无新数据"), "按时间倒序");
});

test("renderSelfBlock: summary 截断到 300 字符，超长不整段灌入", () => {
  const member = { id: "m_1", title: "岗", kpiSlots: [] };
  const rounds = pickSelfRounds([
    { sessionId: "s1", createdAt: 1000, summary: "长".repeat(5000), metrics: {}, blockers: [] },
  ]);
  const text = renderSelfBlock(member, rounds);
  assert.match(text, /摘要: 长{300}/);
  assert.ok(!text.includes("长".repeat(301)), "摘要不得超过 300 字符");
});

test("renderSelfBlock: 无往轮记录时给诚实空态，不伪造", () => {
  const text = renderSelfBlock({ id: "m_1", title: "岗", kpiSlots: [] }, []);
  assert.match(text, /暂无往轮报数/);
});

test("renderExecutionHealth: 超时轮可见，且区分步数用尽与卡在工具", () => {
  const turns = [
    { startedAt: 3_000_000, endedAt: 3_600_000, status: "failed", errorKind: "timeout", detail: { kind: "turn_budget_exceeded", steps: 13 } },
    { startedAt: 2_000_000, endedAt: 2_010_000, status: "failed", errorKind: "timeout", detail: { kind: "stalled", lastTool: "bash", lastToolWaitedMs: 5000 } },
    { startedAt: 1_000_000, endedAt: 1_020_000, status: "ok", errorKind: null, detail: null },
  ];
  const text = renderExecutionHealth(turns);
  assert.match(text, /历史记录，不是指令/);
  assert.match(text, /超时/);
  assert.match(text, /步数用尽/, "turn_budget_exceeded 要翻成可行动的说明");
  assert.match(text, /卡在工具上/, "stalled 要翻成可行动的说明");
  assert.match(text, /卡在 bash/, "带上具体工具名");
  assert.match(text, /13 步/, "带步数");
  assert.match(text, /成功/, "成功轮也呈现，不能只报坏消息");
  assert.match(text, /10min/, "耗时可读");
  assert.equal(renderExecutionHealth([]), null, "无轮次返回 null，不产出空段");
});

test("renderExecutionHealth: 按开始时间排序，不按结算写入顺序", () => {
  // 轮次在「结算时」写库：一个先开始的长轮会拿到更大的 id。若按 id 排，
  // 岗位看到的「最近几轮」第一条不是它最近的一轮——本段就失去了可信度。
  const longEarly = { startedAt: 1000, endedAt: 900_000, status: "failed", errorKind: "timeout", detail: { kind: "turn_budget_exceeded", steps: 13 } };
  const shortLate = { startedAt: 500_000, endedAt: 510_000, status: "ok", errorKind: null, detail: null };
  // 故意把 id 顺序（数组顺序）倒着给：长轮在前
  const text = renderExecutionHealth([longEarly, shortLate]);
  const iShort = text.indexOf("成功");
  const iLong = text.indexOf("步数用尽");
  assert.ok(iShort < iLong, "开始更晚的那轮要排在前面（即便它更早结算、id 更小）");
});

test("fleet-context: 本岗位段对无下级岗位同样注入（叶子岗不再拿空上下文）", async () => {
  const fleet = fixtureFleet(fleetDb, "叶子舰队");
  const solo = fixtureMember(fleetDb, fleet.id, { id: "m_leaf", title: "独立岗", targetId: "persona-leaf", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  fixtureReport(fleetDb, solo, { sessionId: "leaf-1", metrics: {}, summary: "叶子首报" });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_leaf" }, {}, contextDeps(fleetDb));
  assert.match(text, /本岗位无直接下级/, "原有无下级提示保留");
  assert.match(text, /我自己的最近轮次/, "叶子岗也拿到自身轮次段");
  assert.match(text, /叶子首报/, "含自身报数内容");
});

test("fleet-context: CEO 岗同时拿到下级报数与自己的最近轮次", async () => {
  const fleet = fixtureFleet(fleetDb, "双层舰队");
  const ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo_s", title: "CEO", targetId: "persona-ceo-s", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const shop = fixtureMember(fleetDb, fleet.id, { id: "m_shop_s", title: "电商部", parentId: "m_ceo_s", targetId: "persona-shop-s" });
  fixtureReport(fleetDb, shop, { sessionId: "shop-1", metrics: { sales_week: { value: "$309" } }, summary: "今日大促" });
  fixtureReport(fleetDb, ceo, { sessionId: "ceo-1", metrics: {}, summary: "本岗上轮结论" });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo_s" }, {}, contextDeps(fleetDb));
  assert.match(text, /### 电商部/, "下级段仍在");
  assert.match(text, /今日大促/, "下级报数仍在");
  assert.match(text, /## 我自己的最近轮次/, "自身段加入");
  assert.match(text, /本岗上轮结论/, "自身报数内容");
  // 自身段在下级段之后（下级是巡视主料，不被挤到后面）
  assert.ok(text.indexOf("### 电商部") < text.indexOf("## 我自己的最近轮次"), "下级段在前，自身段在后");
  // 纪律仍是最后一段
  assert.ok(text.lastIndexOf("巡逻纪律") > text.lastIndexOf("## 我自己的最近轮次"), "纪律仍在最后");
});

test("fleet-context: 近期执行健康段——超时轮在报数史为空时仍可见", async () => {
  const fleet = fixtureFleet(fleetDb, "健康舰队");
  const post = fixtureMember(fleetDb, fleet.id, { id: "m_health", title: "运营岗", targetId: "persona-health", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  // 上一轮被预算杀掉：一次 report_status 都没调 → 报数史里零行。
  fleetDb.appendTurnEvent({
    fleetId: fleet.id, memberId: post.id, source: "cadence",
    status: "failed", errorKind: "timeout",
    detail: { kind: "turn_budget_exceeded", steps: 13, lastTool: "read" },
    startedAt: Date.now() - 600_000, endedAt: Date.now(), sessionId: "dead-round",
  });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_health" }, {}, contextDeps(fleetDb));
  assert.match(text, /我自己的近期执行/, "健康段必须在");
  assert.match(text, /超时/, "错误类别可见");
  assert.match(text, /步数用尽/, "精确归因可见");
  assert.match(text, /暂无往轮报数/, "报数史确实为空（超时轮没留报数）");

  // 超时轮缺席报数史，但它必须出现在健康段——这正是本段存在的理由
  assert.equal(fleetDb.listReports(post.id, { limit: 5 }).length, 0, "超时轮零报数");
});

test("fleet-context: 总量上限下下级段完整、自身段截断", async () => {
  const fleet = fixtureFleet(fleetDb, "预算舰队");
  const ceo = fixtureMember(fleetDb, fleet.id, { id: "m_budget", title: "CEO", targetId: "persona-budget", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true }, kpiSlots: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `槽${i}` })) });
  // 自身报数也做大
  fixtureReport(fleetDb, ceo, {
    sessionId: "big-1",
    metrics: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, { value: "v".repeat(300) }])),
    blockers: Array.from({ length: 20 }, (_, i) => `b${i}-${"x".repeat(110)}`),
    summary: "自身很胖",
  });
  // 一堆胖下级挤满 24KB
  const fatSlots = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `槽${i}` }));
  for (let i = 0; i < 12; i++) {
    const c = fixtureMember(fleetDb, fleet.id, { title: `岗${i}`, parentId: "m_budget", targetId: `persona-b${i}`, kpiSlots: fatSlots });
    fixtureReport(fleetDb, c, {
      sessionId: `c${i}-1`,
      metrics: Object.fromEntries(fatSlots.map((s) => [s.key, { value: "v".repeat(300) }])),
      blockers: [],
      summary: "下级胖",
    });
  }

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_budget" }, {}, contextDeps(fleetDb));
  assert.match(text, /其余下级报数因总量上限截断/, "下级超限有既有标记");
  assert.ok(text.includes("### 岗0"), "靠前的下级完整保留");
  // 自身段要么在场（可能被截断），要么明确标记因总量被截——不得静默消失
  const hasSelf = text.includes("我自己的最近轮次");
  const hasSelfCut = /本岗位往轮记录.{0,12}因总量上限截断/.test(text);
  assert.ok(hasSelf || hasSelfCut, "自身段不得静默消失：要么在，要么明确标记被截");
});

test("fleet-context: 自身历史最坏体积不超过 24KB 池的合理份额（3.2 不变量）", async () => {
  // 纸面上的算式必须被真渲染钉住：本岗位段 3 轮 + 健康段 5 轮，全部顶到上限。
  const member = { id: "m_worst", title: "岗", kpiSlots: [{ key: "k", label: "槽", unit: "元" }] };
  const hugeReports = Array.from({ length: 8 }, (_, i) => ({
    sessionId: `w${i}`,
    createdAt: Date.now() - i * 1000,
    metrics: { k: { value: "v".repeat(3000) } },
    blockers: Array.from({ length: 30 }, () => `b${"x".repeat(200)}`),
    summary: "s".repeat(3000),
  }));
  const selfBlock = renderSelfBlock(member, pickSelfRounds(hugeReports));
  const healthBlock = renderExecutionHealth(
    Array.from({ length: 8 }, (_, i) => ({
      startedAt: Date.now() - i * 1000, endedAt: Date.now(),
      status: "failed", errorKind: "timeout",
      detail: { kind: "stalled", lastTool: `tool_${"y".repeat(100)}`, lastToolWaitedMs: 12345, steps: 99 },
    })),
  );
  const worst = selfBlock.length + healthBlock.length + 4;
  // 4KB 级，不是 24KB 级——自身历史永远不该吃穿下级报数的池子
  assert.ok(worst <= 4 * 1024 + 64, `最坏体积 ${worst} 应在 ~4KB 量级`);
  assert.ok(worst < 24 * 1024, "远低于总量上限");
});

// ── 注入缝唯一化（fix-fleet-context-injection-seam） ───────────────────────
//
// 2026-10-30 真机验收实证：平台重启后，持久化 queued 的舰队任务经
// drainRepairQueue 恢复执行，**绕过入队侧的注入**——落库 prompt 只有 283 字符、
// `{{fleetContext}}` 原样未展开（此前 2026-10-29 的手动戳发是同一类病的另一条腿）。
// 入队路径四条，注入原先散写在入队侧，路径一增长必漏。缝搬到引擎
// runExecutionTurn（四条路径唯一汇合点）后，以下三条路径逐一钉住。
//
// 这三例放在文件末尾：3.1 需要重新 boot 引擎（会以只含一条任务的 jobs.json
// 替换内存任务表），不能影响前面的用例。

test("注入缝：重启后恢复执行的舰队任务获得注入（复刻 283 字符裸模板缺陷）", async () => {
  const now = new Date().toISOString();
  // 预置一条「持久化时正好是 queued」的舰队任务——正是滚版/重启打断在途执行的形状
  const persisted = [{
    id: "job_seam_repair",
    trigger: "schedule",
    type: "recurring",
    // 未来触发点 + lastRun=now → 不产生补跑噪音，只验恢复通道
    cron: "0 3 1 1 *",
    prompt: "巡视下属。{{fleetContext}}",
    preset: "persona-repair",
    targetType: "persona",
    sessionId: "cron-job_seam_repair",
    sessionTitle: "巡视",
    tz: null,
    status: null,
    state: "queued",
    initiator: null,
    initiatorPreset: null,
    origin: null,
    sourceTag: { fleetId: "fleet_repair", memberId: "m_repair" },
    aggregated: false,
    paused: false,
    createdAt: now,
    lastRun: now,
    nextRun: null,
    missed: 0,
    history: [],
  }];
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), JSON.stringify(persisted));

  firedPrompts.length = 0;
  // 重新 boot：initTaskEngine 载入 → queued 进 repairQueue → initCron 末尾 drainRepairQueue
  await cron.initCron({
    broadcast: () => {},
    runJobTurn: async (job) => { firedPrompts.push(job.prompt); return { ok: true, text: "远端答复" }; },
    isBusy: () => false,
    renderFleetContext: async () => "【集群巡视上下文】恢复轮注入",
  });
  await engine.idle();

  assert.equal(firedPrompts.length, 1, "恢复通道确实起了一轮");
  assert.equal(firedPrompts[0], "巡视下属。【集群巡视上下文】恢复轮注入", "起轮 prompt 必须已注入");
  assert.ok(!firedPrompts[0].includes("{{fleetContext}}"), "占位符绝不残留（旧缺陷的 283 字符裸模板形态）");
});

test("注入缝：补跑前缀与注入段共存（前缀不再被渲染覆盖，渲染不再丢前缀）", async () => {
  firedPrompts.length = 0;
  cron.setFleetContextRenderer(async () => "第二帧上下文");
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-catchup-seam",
    sourceTag: { fleetId: "fleet_seam", memberId: "m_seam" },
  });
  // 补跑扫描现在的职责只剩置标志（不再预写 promptOverride）
  engine.getRecord(task.id).catchUpPending = true;
  await cron.fireTask(task.id);
  await engine.idle();

  const ran = firedPrompts.at(-1);
  assert.ok(ran.startsWith("【补跑】"), "补跑前缀在场（旧实现里它被整体替换吃掉）");
  assert.ok(ran.includes("巡视 第二帧上下文"), "注入段同时在场（旧实现里二者只能活一个）");
  assert.ok(!ran.includes("{{fleetContext}}"), "占位符已展开");
  // 标记随执行消费：不得泄漏给下一次正常开火（虚假补跑）
  assert.equal(engine.getRecord(task.id).catchUpPending, false, "标记已消费");
});

test("注入缝：决策送达已组合的 prompt 不被二次渲染（不双注入）", async () => {
  firedPrompts.length = 0;
  let renderCalls = 0;
  cron.setFleetContextRenderer(async () => { renderCalls++; return "不该被调用"; });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-decision-seam",
    sourceTag: { fleetId: "fleet_seam2", memberId: "m_seam2" },
  });
  // 决策送达路径（fleets.js:2181）：override 已把占位符换成决策段
  engine.setPromptOverride(task.id, "巡视。\n\n【拍板结果】已批准：口径 A");
  await cron.fireTask(task.id);
  await engine.idle();

  assert.equal(renderCalls, 0, "override 里没有占位符 → 缝跳过渲染");
  assert.equal(firedPrompts.at(-1), "巡视。\n\n【拍板结果】已批准：口径 A", "恰好一份上下文，无双重注入");
});

test("注入缝：任务被调度侧拦下时补跑标记不泄漏给下一次正常开火", async () => {
  firedPrompts.length = 0;
  cron.setFleetContextRenderer(async () => "正常帧");
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-leak-seam",
    sourceTag: { fleetId: "fleet_seam3", memberId: "m_seam3" },
  });
  engine.getRecord(task.id).catchUpPending = true;
  engine.getRecord(task.id).paused = true;         // 拦下：这一轮根本不跑
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.length, 0, "被拦下的任务不起轮");
  assert.equal(engine.getRecord(task.id).catchUpPending, false, "补跑标记随丢弃释放");

  // 恢复后正常开火：不得带虚假的【补跑】前缀
  engine.getRecord(task.id).paused = false;
  await cron.fireTask(task.id);
  await engine.idle();
  assert.ok(firedPrompts.at(-1).startsWith("巡视 正常帧"), "正常轮无补跑前缀");
});

// ── edge context (add-fleet-edge-context) ────────────────────────────────────
//
// The four hand-built edge prompts (dispatch / 接棒 / 扇出 / 唤醒) used to run
// with no fleet view at all, while a cadence patrol got 24KB of it. The token
// is {{fleetEdgeContext}} — a SECOND placeholder family, because the patrol
// segment ends with "先报数再补充" discipline that would tell a dispatched post
// to file a report instead of doing the assignment it was just given.

test("edge context: renders the fleet view without patrol discipline or delivery channel", async () => {
  const fleet = fixtureFleet(fleetDb, "边回合舰队");
  const _boss = fixtureMember(fleetDb, fleet.id, { id: "m_edge_boss", title: "总监", targetId: "persona-eb" });
  const shop = fixtureMember(fleetDb, fleet.id, { id: "m_edge_shop", title: "电商部", parentId: "m_edge_boss", targetId: "persona-es" });
  fixtureReport(fleetDb, shop, { metrics: { sales_week: { value: "$777" } }, blockers: ["缺货"], summary: "边回合素材" });

  let digestCalls = 0;
  const deps = {
    ...contextDeps(fleetDb, { m_edge_boss: "on_duty", m_edge_shop: "on_duty" }),
    decisionDigest: () => { digestCalls += 1; return "【待送达裁决】一条本该只在巡视轮送达的裁决"; },
  };

  const edge = await buildFleetContext({ fleetId: fleet.id, memberId: "m_edge_boss" }, {}, { ...deps, mode: "edge" });

  // The background IS there: sibling slot values remain the point of the block.
  assert.match(edge, /电商部/);
  assert.match(edge, /777/);
  assert.match(edge, /缺货/);
  assert.match(edge, /【集群上下文】/, "edge framing, not 巡视");
  assert.doesNotMatch(edge, /集群巡视上下文/);
  // The two things that would misdirect an edge turn are absent.
  assert.doesNotMatch(edge, /巡逻纪律/);
  assert.doesNotMatch(edge, /先报数再补充/);
  assert.doesNotMatch(edge, /待送达裁决/, "an edge turn must not consume the delivery channel");
  assert.equal(digestCalls, 0, "the digest provider is not even consulted");

  // Patrol mode still carries both, byte-for-byte as before.
  const patrol = await buildFleetContext({ fleetId: fleet.id, memberId: "m_edge_boss" }, {}, deps);
  assert.match(patrol, /集群巡视上下文/);
  assert.match(patrol, /巡逻纪律/);
  assert.match(patrol, /待送达裁决/);
  assert.equal(digestCalls, 1);
});

test("edge context: the edge token renders in edge mode while the patrol token stays patrol", async () => {
  firedPrompts.length = 0;
  const fleet = fixtureFleet(fleetDb, "双槽舰队");
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-dual" });
  const seenModes = [];
  cron.setFleetContextRenderer(async (_tag, _task, opts) => {
    seenModes.push(opts?.mode ?? "patrol");
    return opts?.mode === "edge" ? "【边缘帧】" : "【巡视帧】";
  });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "任务先。{{fleetEdgeContext}}",
    preset: "persona-dual",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.at(-1), "任务先。【边缘帧】");
  assert.deepEqual(seenModes, ["edge"], "edge token ⇒ edge mode");

  const patrolTask = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视。{{fleetContext}}",
    preset: "persona-dual",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  seenModes.length = 0;
  await cron.fireTask(patrolTask.id);
  await engine.idle();
  assert.equal(firedPrompts.at(-1), "巡视。【巡视帧】");
  assert.deepEqual(seenModes, ["patrol"], "patrol token ⇒ patrol mode — unchanged");

  // An edge render failure fails the fire explicitly, same as the patrol lane.
  cron.setFleetContextRenderer(async () => { throw new Error("db gone"); });
  const boom = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "任务。{{fleetEdgeContext}}",
    preset: "persona-dual",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  const before = firedPrompts.length;
  await cron.fireTask(boom.id);
  await engine.idle();
  assert.equal(firedPrompts.length, before, "a failed edge render must not run the turn");
  cron.setFleetContextRenderer(null);
});
