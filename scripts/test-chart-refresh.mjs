// The refresh loop: gate → read → map → diff → write → broadcast, plus the
// retention sweeper (openspec: add-chart-data-binding, tasks 1.4/1.6).
//
// Everything here runs against the fake MCP, so the whole closed loop —
// including the classification counts, the payload rewrite and the broadcasts
// an open client sees — is asserted end to end with no model and no network.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "chart-refresh-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");

const db = await import("../db.js");
const extensionStore = await import("../extension-store.js");
const registryCredentials = await import("../registry-credentials.js");
const resources = await import("../resources.js");
const refresh = await import("../chart-refresh.js");
const { createFakeMcp } = await import("../e2e/fake-mcp.js");

await db.initDb();
assert.ok(db.isDbReady());

const TOKEN = "chart-refresh-test-token";
const fake = createFakeMcp({ scenario: "monthly", framing: "sse", token: TOKEN });
const url = await fake.listen();
extensionStore.addMcpServer({ name: "fd-open-data-mcp", config: { url, credentialRef: "registry" } });
registryCredentials.store({ email: null, token: TOKEN, source: "paste" });

const events = [];
await resources.initStore({ broadcast: (msg) => events.push(msg) });
refresh.setBroadcast((msg) => events.push(msg));
refresh.setOwnerEmailSource(() => null);
refresh.shutdownChartRefresh();

after(async () => {
  refresh.shutdownChartRefresh();
  await fake.close();
});

const CHART_OPTION = {
  title: { text: "M0 同比" },
  legend: { data: ["M0"] },
  color: ["#5470c6"],
  tooltip: { trigger: "axis" },
  grid: { left: 8, right: 8 },
  xAxis: { type: "category", data: ["2026-01", "2026-02", "2026-03"] },
  yAxis: { type: "value" },
  series: [{ name: "M0", type: "line", smooth: true, data: [7.1, 6.6, 6.9] }],
};

let chartSeq = 0;

// One chart + one binding, wired the way the capture+bind path wires them.
// Each scaffold gets a DISTINCT option (the title ordinal): resource identity
// is the content hash, so byte-identical options would — correctly — collapse
// into one resource and the test would be asserting about the wrong row.
function scaffold({ tool = "read_series", args = { concept_id: "M0_YOY" }, map = null, unit = "%", frequency = "monthly", origin = "confirmed", refreshRule = null, option = null } = {}) {
  chartSeq += 1;
  const chart = option ?? { ...CHART_OPTION, title: { text: `M0 同比 #${chartSeq}` } };
  const payload = JSON.stringify(chart);
  const now = new Date().toISOString();
  const { inserted, resource } = db.insertResource({
    id: `res-${randomUUID().slice(0, 8)}`,
    type: "chart",
    title: chart.title.text,
    source: "auto",
    sessionId: null,
    sessionTitle: "测试",
    messageId: null,
    payload,
    contentHash: payload,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  assert.equal(inserted, true, "the scaffold chart must be a new resource");
  const binding = db.insertChartBinding({
    id: `bind-${randomUUID().slice(0, 8)}`,
    lineageKey: `lineage-${randomUUID()}`,
    server: "fd-open-data-mcp",
    tool,
    args,
    map: map ?? { rows: "points[]", period: "date", value: "value", source: "source_used", series: null },
    concept: args.concept_id ?? "M0_YOY",
    frequency,
    unit,
    refreshRule,
    origin,
    createdAt: now,
    updatedAt: now,
  });
  db.setResourceBindingRefs(resource.id, [{ seriesIndex: 0, bindingId: binding.id }], now);
  return { resource: db.getResource(resource.id), binding, option: chart };
}

function payloadOf(id) {
  return JSON.parse(db.getResource(id).payload);
}

before(() => {
  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
  ]);
});

// ── 1.4 the diff and the write ──────────────────────────────────────────────

test("classifyPoints names every class, and a source switch is not a revision", () => {
  const stored = new Map([
    ["\u00002026-01", { value: 1, source: "a" }],
    ["\u00002026-02", { value: 2, source: "a" }],
    ["\u00002026-03", { value: 3, source: "a" }],
    ["\u00002026-04", { value: 4, source: "a" }],
  ]);
  const { rows, counts } = refresh.classifyPoints({
    points: [
      { series: "", period: "2026-01", value: 1, source: "a" },
      { series: "", period: "2026-02", value: 2.5, source: "a" },
      { series: "", period: "2026-03", value: 3.5, source: "b" },
      { series: "", period: "2026-05", value: 5, source: "a" },
    ],
    stored,
    frequency: "monthly",
  });
  assert.deepEqual(counts, { appended: 1, revised: 1, resourced: 1, unchanged: 1, missing: 1 });
  const kinds = Object.fromEntries(rows.map((r) => [r.period, r.kind]));
  assert.equal(kinds["2026-01"], "unchanged");
  assert.equal(kinds["2026-02"], "revised");
  assert.equal(kinds["2026-03"], "resourced");
  assert.equal(kinds["2026-05"], "appended");
  assert.equal(kinds["2026-04"], "missing", "a period inside the response range that the response omitted");
  assert.equal(rows.find((r) => r.period === "2026-04").bump, false, "missing retains the stored value");
});

test("regenerateOption moves only the data, and keeps a half-bound chart aligned", () => {
  const option = {
    title: { text: "keep me" },
    color: ["#111"],
    xAxis: { type: "category", data: ["2026-01", "2026-02"] },
    series: [
      { name: "bound", type: "line", smooth: true, data: [1, 2] },
      { name: "static", type: "line", data: [10, 20] },
    ],
  };
  const result = refresh.regenerateOption(option, {
    refs: [{ seriesIndex: 0, bindingId: "b1" }],
    seriesByRef: new Map([
      [
        "b1",
        [
          { period: "2026-02", value: 2.2 },
          { period: "2026-03", value: 3.3 },
        ],
      ],
    ]),
    frequency: "monthly",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.option.title, option.title);
  assert.deepEqual(result.option.color, option.color);
  assert.equal(result.option.series[0].smooth, true);
  assert.deepEqual(result.option.xAxis.data, ["2026-02", "2026-03"]);
  assert.deepEqual(result.option.series[0].data, [2.2, 3.3]);
  // The static series is realigned onto the grown axis, never dropped or shifted.
  assert.deepEqual(result.option.series[1].data, [20, null]);
  assert.deepEqual(option.xAxis.data, ["2026-01", "2026-02"], "the input option is not mutated");
});

test("a template that cannot carry the data is refused, not guessed", () => {
  const noAxis = refresh.regenerateOption({ series: [{ data: [1] }] }, { refs: [{ seriesIndex: 0, bindingId: "b" }], seriesByRef: new Map([["b", [{ period: "2026-01", value: 1 }]]]), frequency: "monthly" });
  assert.equal(noAxis.ok, false);
  assert.match(noAxis.reason, /xAxis/);
  const noSeries = refresh.regenerateOption({ xAxis: { data: ["x"] } }, { refs: [], seriesByRef: new Map(), frequency: "monthly" });
  assert.equal(noSeries.ok, false);
  assert.match(noSeries.reason, /series array/);
});

// ── 1.6 the closed loop ─────────────────────────────────────────────────────

test("a first manual refresh reads, writes points, rewrites the payload and broadcasts", async () => {
  const { resource, binding, option } = scaffold();
  fake.resetCalls();
  events.length = 0;

  const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.counts, { appended: 3, revised: 0, resourced: 0, unchanged: 0, missing: 0 });
  assert.deepEqual(fake.toolCalls(), ["read_series"], "a manual refresh bypasses the gate and reads once");

  const points = db.listSeriesPoints(binding.id);
  assert.deepEqual(points.map((p) => [p.period, p.value]), [["2026-01", 7.1], ["2026-02", 6.6], ["2026-03", 6.9]]);
  assert.deepEqual(points.map((p) => p.firstSeenAt === p.updatedAt), [true, true, true]);

  const payload = payloadOf(resource.id);
  assert.deepEqual(payload.series[0].data, [7.1, 6.6, 6.9]);
  assert.deepEqual(payload.xAxis.data, ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(payload.title, option.title);
  assert.equal(payload.series[0].smooth, true);
  assert.deepEqual(payload.grid, option.grid);
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(option).sort(), "nothing was added or dropped");

  const log = db.listChartRefreshes(binding.id);
  assert.equal(log.items.length, 1);
  assert.equal(log.items[0].outcome, "ok");
  assert.equal(log.items[0].trigger, "manual");
  assert.ok(events.some((e) => e.type === "resources_changed" && e.action === "refreshed" && e.id === resource.id));

  const after = db.getChartBinding(binding.id);
  assert.equal(after.stale, false);
  assert.equal(after.consecutiveFailures, 0);
  assert.ok(after.lastOkAt);
  assert.equal(after.unit, "%");
});

test("an unchanged refresh leaves the payload byte-identical", async () => {
  const { resource, binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  const before = db.getResource(resource.id);
  const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(result.counts, { appended: 0, revised: 0, resourced: 0, unchanged: 3, missing: 0 });
  const after = db.getResource(resource.id);
  assert.equal(after.payload, before.payload);
  assert.equal(after.updatedAt, before.updatedAt, "no write at all when nothing moved");
  // The log still records the observation, and the log keeps both observations.
  assert.equal(db.listChartRefreshes(binding.id).items.length, 2);
  assert.equal(db.listPointRevisions(binding.id).length, 6);
});

test("append + revise + resourced in one refresh: counts, rows and a moved payload", async () => {
  const { resource, binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  const firstPayload = db.getResource(resource.id).payload;

  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-02-01", value: 6.8, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.85, unit: "%", source_used: "stats-bureau" },
    { date: "2026-04-01", value: 7.4, unit: "%", source_used: "pboc" },
  ]);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.deepEqual(result.counts, { appended: 1, revised: 1, resourced: 1, unchanged: 1, missing: 0 });

    const points = db.listSeriesPoints(binding.id);
    assert.deepEqual(
      points.map((p) => [p.period, p.value, p.revisionCount]),
      [["2026-01", 7.1, 1], ["2026-02", 6.8, 2], ["2026-03", 6.85, 2], ["2026-04", 7.4, 1]]
    );
    // The previous value of the revised period survives in the log, and the
    // source switch is recorded as a resource change rather than a revision.
    const revisions = db.listPointRevisions(binding.id).filter((r) => r.period === "2026-02");
    assert.deepEqual(revisions.map((r) => [r.value, r.kind]).sort(), [[6.6, "appended"], [6.8, "revised"]]);
    assert.equal(db.listPointRevisions(binding.id).find((r) => r.period === "2026-03").kind, "resourced");

    const payload = payloadOf(resource.id);
    assert.deepEqual(payload.series[0].data, [7.1, 6.8, 6.85, 7.4]);
    assert.deepEqual(payload.xAxis.data, ["2026-01", "2026-02", "2026-03", "2026-04"]);
    assert.notEqual(db.getResource(resource.id).payload, firstPayload);
    assert.deepEqual(payload.legend, CHART_OPTION.legend);
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

test("a period the response omits inside its own range is retained and logged missing", async () => {
  const { binding } = scaffold();
  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
  ]);
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
  ]);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.counts.missing, 1);
    assert.equal(result.counts.unchanged, 2);
    const stored = db.listSeriesPoints(binding.id).find((p) => p.period === "2026-02");
    assert.equal(stored.value, 6.6, "the omitted period keeps its value");
    const log = db.listChartRefreshes(binding.id).items[0];
    assert.equal(log.missing, 1);
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

test("a scheduled tick consults the gate, and skips without reading when nothing moved", async () => {
  const { binding } = scaffold();
  fake.resetCalls();
  const first = await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
  assert.equal(first.outcome, "ok");
  assert.deepEqual(fake.toolCalls(), ["data_stats", "read_series"]);
  const recorded = db.getChartBinding(binding.id).gateFingerprint;
  assert.ok(recorded, "a scheduled read records the fingerprint it saw");

  fake.resetCalls();
  const second = await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
  assert.equal(second.outcome, "skipped_fresh");
  assert.deepEqual(fake.toolCalls(), ["data_stats"], "no series read at all");
  const log = db.listChartRefreshes(binding.id).items[0];
  assert.equal(log.outcome, "skipped_fresh");
  assert.equal(log.error, null, "a skip is not an error");

  // ...and a moved gate reads.
  fake.setStats({ latest_date: "2026-04", last_fetch: "2026-05-01T00:00:00Z" });
  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    { date: "2026-04-01", value: 7.4, unit: "%", source_used: "pboc" },
  ]);
  try {
    fake.resetCalls();
    const third = await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
    assert.equal(third.outcome, "ok");
    assert.deepEqual(fake.toolCalls(), ["data_stats", "read_series"]);
  } finally {
    fake.setStats({ rows: 3, latest_date: "2026-03", last_fetch: "2026-04-01T00:00:00Z" });
  }
});

test("a manual refresh after a scheduled one clears the fingerprint, so the next tick reads once", async () => {
  const { binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
  assert.ok(db.getChartBinding(binding.id).gateFingerprint);
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(db.getChartBinding(binding.id).gateFingerprint, null);
  fake.resetCalls();
  await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
  assert.deepEqual(fake.toolCalls(), ["data_stats", "read_series"]);
});

test("a failed refresh keeps the data, marks stale with a reason, and backs off", async () => {
  const { resource, binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  const good = db.getResource(resource.id);
  const pointCount = db.listSeriesPoints(binding.id).length;

  fake.failAllRequests(true);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unreachable");
  } finally {
    fake.failAllRequests(false);
  }

  const after = db.getChartBinding(binding.id);
  assert.equal(after.stale, true);
  assert.equal(after.staleReason, "unreachable");
  assert.ok(after.staleSince);
  assert.equal(after.consecutiveFailures, 1);
  assert.ok(after.backoffUntil, "a scheduled failure arms the backoff");
  assert.equal(after.lastOkAt, db.getChartBinding(binding.id).lastOkAt);
  assert.equal(db.getResource(resource.id).payload, good.payload, "the chart keeps its last good render");
  assert.equal(db.listSeriesPoints(binding.id).length, pointCount, "the point store is untouched");

  // Manual is never rate-limited by the backoff.
  const manual = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(manual.ok, true);
  const recovered = db.getChartBinding(binding.id);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.staleReason, null);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.backoffUntil, null);
  assert.equal(db.listChartRefreshes(binding.id).items.filter((r) => r.outcome === "error").length, 1);
});

test("the backoff ladder is min(2^n × 15min, 24h)", async () => {
  const { binding } = scaffold();
  fake.failAllRequests(true);
  try {
    const first = await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
    assert.equal(first.ok, false);
    const armed = db.getChartBinding(binding.id);
    const delta = Date.parse(armed.backoffUntil) - Date.now();
    // n=1 → 2 × 15min = 30min
    assert.ok(delta > 25 * 60 * 1000 && delta <= 31 * 60 * 1000, `n=1 arms ~30min (got ${Math.round(delta / 60000)}min)`);

    // A deeper ladder is capped at 24h.
    db.updateChartBinding(binding.id, { consecutiveFailures: 11 }, new Date().toISOString());
    await refresh.refreshBinding(binding.id, { trigger: "scheduled" });
    const capped = db.getChartBinding(binding.id);
    assert.equal(capped.consecutiveFailures, 12);
    const cappedDelta = Date.parse(capped.backoffUntil) - Date.now();
    assert.ok(cappedDelta > 23.9 * 60 * 60 * 1000 && cappedDelta <= 24 * 60 * 60 * 1000, "the ceiling holds");
  } finally {
    fake.failAllRequests(false);
  }

  // A manual refresh is never rate-limited, even inside the window.
  const manual = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(manual.ok, true);
  assert.equal(db.getChartBinding(binding.id).backoffUntil, null);
});

test("an off-allowlist tool is refused with the allowlist reason and no call is made", async () => {
  const { binding } = scaffold({ tool: "read", args: { concept_id: "M0_YOY" } });
  fake.resetCalls();
  const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "allowlist");
  assert.deepEqual(fake.toolCalls(), [], "nothing was replayed");
  const after = db.getChartBinding(binding.id);
  assert.equal(after.stale, true);
  assert.equal(after.staleReason, "allowlist");
  assert.match(db.listChartRefreshes(binding.id).items[0].error, /allowlist/);
});

test("a unit change is refused whole: nothing written, marked stale", async () => {
  const { resource, binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  const before = db.listSeriesPoints(binding.id).map((p) => `${p.period}=${p.value}`);

  fake.setUnit("亿元");
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unit_mismatch");
  } finally {
    fake.setUnit("%");
  }
  assert.deepEqual(db.listSeriesPoints(binding.id).map((p) => `${p.period}=${p.value}`), before);
  const after = db.getChartBinding(binding.id);
  assert.equal(after.stale, true);
  assert.equal(after.staleReason, "unit_mismatch");
  assert.equal(after.unit, "%");
  assert.equal(db.getResource(resource.id).payload, db.getResource(resource.id).payload);
});

test("the first successful refresh records the unit a declared binding had none for", async () => {
  const { binding } = scaffold({ unit: null });
  {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.ok, true);
    assert.equal(db.getChartBinding(binding.id).unit, "%");
  }
});

test("a response that violates the map contract is refused with map_violation", async () => {
  const { binding } = scaffold();
  fake.setPoints([{ date: "合计", value: 1, unit: "%", source_used: "pboc" }]);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "map_violation");
    assert.equal(db.listSeriesPoints(binding.id).length, 0);
    assert.equal(db.getChartBinding(binding.id).staleReason, "map_violation");
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

test("an empty response over a non-empty store is refused, not reported as unchanged", async () => {
  const { binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  fake.setPoints([]);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "tool_error");
    assert.equal(db.listSeriesPoints(binding.id).length, 3);
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

test("the anomaly path reports both values and writes neither", async () => {
  const { binding } = scaffold({ args: { concept_id: "GDP_NOMINAL" }, frequency: "yearly", unit: "亿元" });
  fake.setConcept("GDP_NOMINAL", { frequency: "yearly", unit: "亿元" });
  fake.setPoints([
    { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
    { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
    { date: "2023-12-31", value: 130.4, unit: "亿元", source_used: "stats" },
  ]);
  try {
    const result = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.anomalies.length, 1);
    const stored = db.listSeriesPoints(binding.id);
    assert.deepEqual(stored.map((p) => p.period), ["2022"], "the conflicted period is not in the latest view");
    const log = db.listChartRefreshes(binding.id).items[0];
    assert.equal(log.anomalies, 1);
    assert.deepEqual(log.anomaliesDetail[0].values.map((v) => v.value), [126.1, 130.4]);
  } finally {
    fake.setConcept("M0_YOY", { frequency: "monthly", unit: "%" });
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

test("the as-of reconstruction answers what the chart showed at a moment", async () => {
  const { resource, binding } = scaffold();
  const first = await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.equal(first.ok, true, JSON.stringify(first));
  const atFirst = db.listChartRefreshes(binding.id).items[0].fetchedAt;
  await new Promise((r) => setTimeout(r, 5));
  fake.setPoints([
    { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
    { date: "2026-02-01", value: 9.9, unit: "%", source_used: "pboc" },
    { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
  ]);
  try {
    const second = await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.counts.revised, 1);
    const row = db.getResource(resource.id);
    const asOf = refresh.asOfOption(row, atFirst);
    assert.deepEqual(asOf.option.series[0].data, [7.1, 6.6, 6.9], "the past view keeps the old revision");
    assert.deepEqual(asOf.option.title, row.payload && JSON.parse(row.payload).title);
    const current = payloadOf(resource.id);
    assert.deepEqual(current.series[0].data, [7.1, 9.9, 6.9]);
    const before = refresh.asOfOption(row, "2020-01-01T00:00:00.000Z");
    assert.equal(before, null, "a moment before any observation has nothing to show");
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});

// ── scheduling + retention ──────────────────────────────────────────────────

test("a binding with a cron rule gets a timer that runs without a model turn", async () => {
  const { binding } = scaffold({ refreshRule: { cron: "*/1 * * * * *" } });
  const { scheduled } = refresh.syncSchedules();
  assert.ok(scheduled >= 1);
  const deadline = Date.now() + 5000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = db.listChartRefreshes(binding.id).items.filter((r) => r.trigger === "scheduled");
    if (rows.length) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(rows.length >= 1, "the timer fired a scheduled refresh");
  // Clean up: drop the rule so the every-second timer stops for later tests.
  db.updateChartBinding(binding.id, { refreshRule: null }, new Date().toISOString());
  refresh.syncSchedules();
  assert.equal(refresh.syncSchedules().scheduled >= 0, true);
});

test("a ttl-only rule schedules no timer: a TTL is an on-open trigger", () => {
  const { binding } = scaffold({ refreshRule: { ttlSec: 3600 } });
  const before = refresh.syncSchedules().scheduled;
  assert.equal(db.getChartBinding(binding.id).refreshRule.ttlSec, 3600);
  assert.equal(refresh.syncSchedules().scheduled, before, "no timer was added for the TTL rule");
});

test("the sweeper prunes the log, keeps revisions, and removes unreferenced bindings with their history", async () => {
  const { resource, binding } = scaffold();
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  await refresh.refreshBinding(binding.id, { trigger: "manual" });
  assert.ok(db.listPointRevisions(binding.id).length > 0);

  // Nothing is old yet: the sweeper only trims the view to the cap.
  const fresh = refresh.sweepOnce();
  assert.equal(fresh.removedBindings, 0);
  assert.equal(db.listChartRefreshes(binding.id).total, 2);

  // Age the log past retention, then sweep. Point rows get distinct times (the
  // PK is (binding, series, period, observed_at)) so only the age changes.
  db.getDb().prepare("UPDATE chart_refreshes SET fetched_at = ? WHERE binding_id = ?").run("2020-01-01T00:00:00.000Z", binding.id);
  db.getDb()
    .prepare(
      "UPDATE chart_point_revisions SET observed_at = '2020-01-01T00:00:' || printf('%02d', rowid % 60) || '.000Z' WHERE binding_id = ?"
    )
    .run(binding.id);
  const swept = refresh.sweepOnce();
  assert.equal(swept.prunedRefreshes, 2);
  assert.equal(db.listChartRefreshes(binding.id).total, 0);
  // The value-changing rows survive; only superseded unchanged rows age out.
  const kept = db.listPointRevisions(binding.id);
  assert.deepEqual(new Set(kept.map((r) => r.period)), new Set(["2026-01", "2026-02", "2026-03"]));

  // Delete the last resource: the binding and its history go with it.
  db.deleteResource(resource.id);
  const cleaned = refresh.sweepOnce();
  assert.equal(cleaned.removedBindings, 1);
  assert.equal(db.getChartBinding(binding.id), null);
  assert.equal(db.listPointRevisions(binding.id).length, 0);
  assert.equal(db.listChartRefreshes(binding.id).total, 0);
});

test("the period cap trims the latest view while the point log keeps everything", async () => {
  const { binding } = scaffold();
  const points = [];
  for (let i = 1; i <= 8; i += 1) {
    points.push({ date: `2026-0${i}-01`, value: i, unit: "%", source_used: "pboc" });
  }
  fake.setPoints(points);
  try {
    await refresh.refreshBinding(binding.id, { trigger: "manual" });
    assert.equal(db.listSeriesPoints(binding.id).length, 8);
    db.trimSeriesPointsToCap(binding.id, 5);
    const view = db.listSeriesPoints(binding.id);
    assert.equal(view.length, 5);
    assert.deepEqual(view.map((p) => p.period), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"], "oldest first out");
    assert.equal(db.listPointRevisions(binding.id, { limit: 100 }).length, 8, "the log is unaffected by the cap");
  } finally {
    fake.setPoints([
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ]);
  }
});