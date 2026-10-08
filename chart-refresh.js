// ── Chart refresh: gate → read → diff → write → broadcast ────────────────────
// (openspec: add-chart-data-binding)
//
// One binding's data path, deterministic end to end: consult the cheap
// freshness gate, read the bound tool, map and normalize the response, classify
// every point against what is already stored, then write the new observations,
// the latest view and the refresh-log row in ONE transaction — and redraw the
// affected charts' payloads through their frozen option template.
//
// Failure semantics are the load-bearing part. A failed refresh touches
// nothing: not the payload, not the point log, not the latest view. It marks
// the binding stale with a machine-readable reason and backs off exponentially
// (scheduled ticks only — the user's own button is never rate-limited).
//
// Scheduling is this module's own node-schedule timers, NOT cron-module jobs:
// a cron job is a prompt-bound model turn the user sees in their task list,
// while a refresh is an invisible data-path loop over data nobody asked a model
// about. Missed ticks while the process was down are skipped, never replayed.

import { randomUUID } from "node:crypto";
import schedule from "node-schedule";
import * as db from "./db.js";
import * as bindings from "./chart-bindings.js";
import {
  calendarBetween,
  callTool,
  evaluateMap,
  freshnessFingerprint,
  normalizePeriod,
  ChartSourceError,
} from "./chart-source.js";

// Backoff ladder: min(2^n × 15min, 24h) on consecutive failures.
const BACKOFF_BASE_MS = Number(process.env.CHART_REFRESH_BACKOFF_BASE_MS || 15 * 60 * 1000);
const BACKOFF_CEILING_MS = Number(process.env.CHART_REFRESH_BACKOFF_CEILING_MS || 24 * 60 * 60 * 1000);
// Retention: refresh-log rows and superseded unchanged observations age out.
const RETENTION_DAYS = Number(process.env.CHART_REFRESH_RETENTION_DAYS || 30);
// The materialized view's period cap; the point log is unaffected.
const PERIOD_CAP = Number(process.env.CHART_PERIOD_CAP || 600);

let broadcast = () => {};
let timers = new Map(); // bindingId -> node-schedule Job
let sweeperTimer = null;
let ownerEmailSource = () => null;
let fetchImpl = fetch;

export class RefreshError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RefreshError";
    this.status = status;
    this.code = code;
  }
}

export function setBroadcast(fn) {
  if (fn) broadcast = fn;
}

export function periodCap() {
  return PERIOD_CAP;
}

function backoffMs(failures) {
  const n = Math.max(1, Number(failures) || 1);
  return Math.min(2 ** Math.min(n, 20) * BACKOFF_BASE_MS, BACKOFF_CEILING_MS);
}

// ── Classification ───────────────────────────────────────────────────────────

// Every point in the response lands in exactly one class. The order of the
// questions matters:
//
//   appended  the period was never observed
//   unchanged the value in force is the same value
//   resourced the value moved AND the source that produced it changed
//   revised   the value moved from the same source
//   missing   the frequency calendar says the period exists in the response's
//             own range but the response has no value for it (the stored value
//             is retained — a refresh never deletes data)
//
// `resourced` before `revised` is the spec's distinction: a source switch is not
// reported as a data revision.
export function classifyPoints({ points, stored, frequency }) {
  const counts = { appended: 0, revised: 0, resourced: 0, unchanged: 0, missing: 0 };
  const rows = [];
  const seen = new Set();

  for (const point of points) {
    const key = `${point.series}\u0000${point.period}`;
    seen.add(key);
    const prior = stored.get(key);
    if (!prior) {
      counts.appended += 1;
      rows.push({ ...point, kind: "appended", bump: true });
      continue;
    }
    if (prior.value === point.value) {
      counts.unchanged += 1;
      rows.push({ ...point, kind: "unchanged", bump: false });
      continue;
    }
    const sameSource = (prior.source ?? null) === (point.source ?? null);
    if (sameSource) {
      counts.revised += 1;
      rows.push({ ...point, kind: "revised", bump: true });
    } else {
      counts.resourced += 1;
      rows.push({ ...point, kind: "resourced", bump: true });
    }
  }

  // Missing: previously stored periods inside the response's own range that the
  // response did not carry. Per series, so a multi-series store cannot leak a
  // range across series.
  const bySeries = new Map();
  for (const point of points) {
    if (!bySeries.has(point.series)) bySeries.set(point.series, []);
    bySeries.get(point.series).push(point.period);
  }
  for (const [series, periods] of bySeries) {
    if (!periods.length) continue;
    const sorted = [...periods].sort();
    const calendar = calendarBetween(sorted[0], sorted[sorted.length - 1], frequency);
    for (const period of calendar) {
      const key = `${series}\u0000${period}`;
      if (seen.has(key) || !stored.has(key)) continue;
      counts.missing += 1;
      rows.push({ series, period, value: stored.get(key).value, source: stored.get(key).source, kind: "missing", bump: false });
    }
  }

  return { rows, counts };
}

// ── The frozen option template ───────────────────────────────────────────────

// Rebuild a chart option's data arrays from stored points without touching
// anything else: title, legend, colors and every styling choice stay exactly as
// captured — only the period axis and the bound series' values move.
//
// A series the resource did NOT bind keeps its captured values, realigned onto
// the (possibly longer) axis by matching each captured label's normalized key.
// That keeps a half-bound chart honest: the static series shows what it always
// showed, in the right place on a grown axis.
export function regenerateOption(option, { refs, seriesByRef, frequency, labelFor = null }) {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return { ok: false, reason: "payload is not a chart option object" };
  }
  const series = option.series;
  if (!Array.isArray(series) || !series.length) {
    return { ok: false, reason: "option has no series array to carry data" };
  }
  const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  if (!axis || typeof axis !== "object" || !Array.isArray(axis.data)) {
    return { ok: false, reason: "option has no category xAxis.data to rewrite" };
  }

  const boundSeries = new Set(refs.map((r) => r.seriesIndex));
  const categories = [];
  for (const ref of refs) {
    for (const point of seriesByRef.get(ref.bindingId) ?? []) {
      if (!categories.includes(point.period)) categories.push(point.period);
    }
  }
  if (!categories.length) return { ok: false, reason: "no stored periods to render" };
  categories.sort();

  const labels = labelFor ? categories.map(labelFor) : categories;
  const originalLabels = [...axis.data];
  const next = JSON.parse(JSON.stringify(option));
  const nextAxis = Array.isArray(next.xAxis) ? next.xAxis[0] : next.xAxis;
  nextAxis.data = labels;

  for (let index = 0; index < next.series.length; index += 1) {
    const seriesEntry = next.series[index];
    if (!seriesEntry || typeof seriesEntry !== "object") continue;
    const ref = refs.find((r) => r.seriesIndex === index);
    if (ref) {
      const byPeriod = new Map((seriesByRef.get(ref.bindingId) ?? []).map((p) => [p.period, p.value]));
      seriesEntry.data = categories.map((period) => (byPeriod.has(period) ? byPeriod.get(period) : null));
      continue;
    }
    if (boundSeries.size === 0) continue;
    // Unbound series: realign its captured values onto the new axis.
    const captured = Array.isArray(seriesEntry.data) ? seriesEntry.data : null;
    if (!captured) continue;
    const positionByKey = new Map();
    originalLabels.forEach((label, i) => {
      const key = normalizePeriod(label, frequency);
      if (key && !positionByKey.has(key)) positionByKey.set(key, i);
    });
    seriesEntry.data = categories.map((period) => {
      const at = positionByKey.get(period);
      return at === undefined ? null : (captured[at] ?? null);
    });
  }
  return { ok: true, option: next };
}

// ── Payload + view assembly ──────────────────────────────────────────────────

function storedPointMap(bindingId) {
  const map = new Map();
  for (const row of db.listSeriesPoints(bindingId)) {
    map.set(`${row.series}\u0000${row.period}`, row);
  }
  return map;
}

function refsForResource(row) {
  const refs = Array.isArray(row?.bindingRefs)
    ? row.bindingRefs
    : typeof row?.bindingRefs === "string"
      ? JSON.parse(row.bindingRefs || "[]")
      : [];
  return (Array.isArray(refs) ? refs : []).filter((r) => r && r.bindingId && Number.isInteger(r.seriesIndex));
}

// Render one option template against an explicit point set. `seriesByRef` maps
// bindingId → points (the shape `listSeriesPoints`/`asOfPoints` return). Returns
// null when the template cannot carry the data — the caller then leaves the
// payload alone, because a template that cannot express the stored data is a
// mapping problem to report, not a value to guess.
export function renderPayload(row, seriesByRef, frequency) {
  const refs = refsForResource(row);
  if (!refs.length || row.type !== "chart" || !seriesByRef?.size) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.payload || "{}");
  } catch {
    return null;
  }
  const result = regenerateOption(parsed, { refs, seriesByRef, frequency });
  return result.ok ? JSON.stringify(result.option) : null;
}

// The latest view AS IT WILL BE once this refresh's points are written. The
// payload has to be rendered from the result, not from the store as it was
// before the write — reading the store here would render the previous refresh.
function projectedPoints(stored, rows) {
  const byPeriod = new Map();
  for (const [key, point] of stored) {
    const period = key.slice(key.indexOf("\u0000") + 1);
    byPeriod.set(period, { period, value: point.value, source: point.source, series: point.series ?? "" });
  }
  for (const row of rows) {
    if (row.kind === "missing") continue;
    byPeriod.set(row.period, { period: row.period, value: row.value, source: row.source, series: row.series ?? "" });
  }
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

// Regenerate one resource's payload from its bindings' CURRENT stored views.
export function payloadForResource(row) {
  const refs = refsForResource(row);
  if (!refs.length || row.type !== "chart") return null;
  const seriesByRef = new Map();
  let frequency = null;
  for (const ref of refs) {
    const points = db.listSeriesPoints(ref.bindingId);
    if (!points.length) continue;
    seriesByRef.set(ref.bindingId, points);
    frequency = frequency ?? db.getChartBinding(ref.bindingId)?.frequency ?? null;
  }
  if (!seriesByRef.size) return null;
  return renderPayload(row, seriesByRef, frequency);
}

// As-of reconstruction: the same template, fed with each binding's latest
// revision at or before `at` — no stored per-refresh option objects, which is
// what keeps the point log the single source of truth.
export function asOfOption(row, atIso) {
  const refs = refsForResource(row);
  if (!refs.length || row.type !== "chart") return null;
  const seriesByRef = new Map();
  let frequency = null;
  for (const ref of refs) {
    const points = db.asOfPoints(ref.bindingId, atIso);
    if (points.length) seriesByRef.set(ref.bindingId, points);
    frequency = frequency ?? db.getChartBinding(ref.bindingId)?.frequency ?? null;
  }
  if (!seriesByRef.size) return null;
  const payload = renderPayload(row, seriesByRef, frequency);
  return payload ? { option: JSON.parse(payload), periods: [...seriesByRef.values()].flat().length } : null;
}

// ── The refresh itself ───────────────────────────────────────────────────────

function writeRefreshRow(binding, { trigger, outcome, counts = null, anomalies = null, gate = null, error = null, durationMs = null, patch = null, points = [], payloadUpdates = [] }) {
  const now = new Date().toISOString();
  db.applyChartRefresh({
    bindingId: binding.id,
    points,
    payloadUpdates,
    refresh: {
      id: randomUUID(),
      bindingId: binding.id,
      fetchedAt: now,
      trigger,
      outcome,
      added: counts?.appended ?? 0,
      revised: counts?.revised ?? 0,
      resourced: counts?.resourced ?? 0,
      unchanged: counts?.unchanged ?? 0,
      missing: counts?.missing ?? 0,
      anomalies: anomalies?.length ?? 0,
      anomaliesDetail: anomalies?.length ? anomalies : null,
      gate,
      error,
      durationMs,
    },
    bindingPatch: patch,
    updatedAt: now,
  });
}

// Tell every client watching the library that a bound chart moved. The payload
// is thin (action + id + type) because clients refetch — the library's
// established contract.
function broadcastRefresh(bindingId) {
  for (const row of db.listResources({ limit: 1000 }).items) {
    const refs = refsForResource(row);
    if (refs.some((r) => r.bindingId === bindingId)) {
      broadcast({ type: "resources_changed", action: "refreshed", id: row.id, resourceType: row.type });
    }
  }
}

function failRefresh(binding, { trigger, code, message, error, durationMs }) {
  const now = new Date().toISOString();
  const failures = (binding.consecutiveFailures || 0) + 1;
  const patch = {
    stale: true,
    staleReason: code,
    staleSince: binding.stale ? binding.staleSince : now,
    consecutiveFailures: failures,
    // The backoff only ever gates SCHEDULED ticks; a user's button bypasses it.
    backoffUntil: trigger === "manual" ? binding.backoffUntil ?? null : new Date(Date.now() + backoffMs(failures)).toISOString(),
  };
  writeRefreshRow(binding, { trigger, outcome: "error", error: error || message, durationMs, patch });
  broadcastRefresh(binding.id);
  return { ok: false, outcome: "error", reason: code, error: error || message };
}

// Read + map + diff + write, for one binding, once. `trigger` is
// manual | scheduled | on-open; only manual skips the freshness gate.
export async function refreshBinding(bindingId, { trigger = "manual", ownerEmail = undefined } = {}) {
  const binding = db.getChartBinding(bindingId);
  if (!binding) throw new RefreshError(404, "binding_not_found", "绑定不存在");
  const started = Date.now();

  // 1. The replay gate, before anything leaves the process.
  if (!bindings.isReplayable(binding.server, binding.tool)) {
    return failRefresh(binding, {
      trigger,
      code: "allowlist",
      message: `refresh refused: ${binding.server}/${binding.tool} is not on the replay allowlist`,
      durationMs: Date.now() - started,
    });
  }

  // 2. On-open TTL: the rule says "refresh when the data is older than this".
  //    Fresh data means there is nothing to do, and nothing is recorded — a
  //    user opening a chart is not an observation attempt, and logging every
  //    open would bury the refreshes that did something.
  if (trigger === "on-open") {
    const ttlSec = Number(binding.refreshRule?.ttlSec);
    if (Number.isFinite(ttlSec) && ttlSec > 0 && binding.lastOkAt) {
      const ageMs = Date.now() - Date.parse(binding.lastOkAt);
      if (Number.isFinite(ageMs) && ageMs < ttlSec * 1000) {
        return { ok: true, outcome: "skipped_fresh", reason: "ttl" };
      }
    }
  }

  // 3. The cheap gate. Scheduled and on-open ticks ask the source's coverage
  //    statistics first; manual always reads. A gate that cannot be read is not
  //    a refresh failure — we fall through and read (a cache read is cheap, and
  //    skipping on an unreadable fingerprint would be a claim we cannot make).
  let gateFingerprint = null;
  if (trigger !== "manual") {
    gateFingerprint = await freshnessFingerprint({
      server: binding.server,
      concept: binding.concept,
      ownerEmail: ownerEmail === undefined ? ownerEmailSource() : ownerEmail,
      fetchImpl,
    }).catch(() => null);
    if (gateFingerprint && gateFingerprint === binding.gateFingerprint) {
      writeRefreshRow(binding, { trigger, outcome: "skipped_fresh", gate: gateFingerprint, durationMs: Date.now() - started });
      return { ok: true, outcome: "skipped_fresh" };
    }
  }

  // 4. Read.
  let result;
  try {
    result = await callTool({
      server: binding.server,
      tool: binding.tool,
      args: binding.args,
      ownerEmail: ownerEmail === undefined ? ownerEmailSource() : ownerEmail,
      fetchImpl,
    });
  } catch (err) {
    const code = err instanceof ChartSourceError ? err.code : "unreachable";
    return failRefresh(binding, { trigger, code, message: err.message, error: err.message, durationMs: Date.now() - started });
  }

  // 5. Map + normalize. A response that does not satisfy the contract is
  //    refused whole — never partially absorbed.
  const evaluated = evaluateMap(result, binding.map, binding.frequency);
  if (!evaluated.ok) {
    return failRefresh(binding, {
      trigger,
      code: "map_violation",
      message: evaluated.reason,
      error: evaluated.reason,
      durationMs: Date.now() - started,
    });
  }

  // 6. The unit contract. Recorded at attach (or at first observation for a
  //    declared binding, which attaches before any fetch); a later mismatch is
  //    refused whole rather than silently rescaled.
  const units = [...evaluated.units];
  if (units.length > 1) {
    return failRefresh(binding, {
      trigger,
      code: "unit_mismatch",
      message: `response mixes units: ${units.join(", ")}`,
      durationMs: Date.now() - started,
    });
  }
  const responseUnit = units[0] ?? null;
  if (binding.unit && responseUnit && responseUnit !== binding.unit) {
    return failRefresh(binding, {
      trigger,
      code: "unit_mismatch",
      message: `unit changed from ${binding.unit} to ${responseUnit}`,
      durationMs: Date.now() - started,
    });
  }

  const stored = storedPointMap(binding.id);
  // An empty response over a non-empty store is not an observation — it is the
  // signature of a re-keyed concept or a changed window. Refuse rather than
  // report "nothing changed" about data we cannot see.
  if (!evaluated.points.length && stored.size) {
    return failRefresh(binding, {
      trigger,
      code: "tool_error",
      message: "response contained no points",
      durationMs: Date.now() - started,
    });
  }

  const { rows, counts } = classifyPoints({
    points: evaluated.points,
    stored,
    frequency: binding.frequency,
  });

  // 7. Write: point revisions + latest view + refresh row + binding state, one
  //    transaction; then the payloads of every chart that renders this binding.
  const observedAt = new Date().toISOString();
  const changed = counts.appended + counts.revised + counts.resourced > 0;
  const patch = {
    stale: false,
    staleReason: null,
    staleSince: null,
    lastOkAt: observedAt,
    consecutiveFailures: 0,
    backoffUntil: null,
    // A manual read establishes no gate reading, so the stored fingerprint is
    // cleared: the next scheduled tick reads once to re-establish it.
    gateFingerprint: trigger === "manual" ? null : gateFingerprint,
  };
  if (!binding.unit && responseUnit) patch.unit = responseUnit;

  const payloadUpdates = [];
  if (changed) {
    for (const row of db.listResources({ limit: 1000 }).items) {
      const refs = refsForResource(row);
      if (!refs.some((r) => r.bindingId === binding.id)) continue;
      // This binding renders from the view this refresh produces; every other
      // bound series of the same chart renders from what it already has.
      const seriesByRef = new Map([[binding.id, projectedPoints(stored, rows)]]);
      for (const ref of refs) {
        if (ref.bindingId === binding.id) continue;
        const points = db.listSeriesPoints(ref.bindingId);
        if (points.length) seriesByRef.set(ref.bindingId, points);
      }
      const payload = renderPayload(row, seriesByRef, binding.frequency);
      if (payload && payload !== row.payload) payloadUpdates.push({ resourceId: row.id, payload });
    }
  }

  writeRefreshRow(binding, {
    trigger,
    outcome: changed ? "ok" : "unchanged",
    counts,
    anomalies: evaluated.anomalies,
    gate: trigger === "manual" ? null : gateFingerprint,
    durationMs: Date.now() - started,
    patch,
    points: rows.map((r) => ({ ...r, observedAt })),
    payloadUpdates,
  });
  db.trimSeriesPointsToCap(binding.id, PERIOD_CAP);
  broadcastRefresh(binding.id);

  return {
    ok: true,
    outcome: changed ? "ok" : "unchanged",
    counts,
    anomalies: evaluated.anomalies,
    unit: binding.unit ?? responseUnit,
    observedAt,
  };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

// A binding with a `{cron, tz}` rule gets a timer. A binding with `{ttlSec}` gets
// NO timer: a TTL is an on-open trigger by definition (the REST route asks
// "stale past TTL?" when the user opens the chart), and turning it into a
// background poll would quietly refresh charts nobody is looking at.
function ruleOf(binding) {
  const rule = binding.refreshRule;
  if (!rule || typeof rule !== "object") return null;
  if (typeof rule.cron === "string" && rule.cron.trim()) {
    return { cron: rule.cron.trim(), tz: typeof rule.tz === "string" && rule.tz ? rule.tz : null };
  }
  return null;
}

async function runScheduled(bindingId) {
  const binding = db.getChartBinding(bindingId);
  if (!binding) {
    unschedule(bindingId);
    return;
  }
  if (binding.backoffUntil && Date.parse(binding.backoffUntil) > Date.now()) {
    // Inside the backoff window: this tick is skipped, not queued. Missed ticks
    // are never replayed — a recovery must not become a storm.
    return;
  }
  try {
    await refreshBinding(bindingId, { trigger: "scheduled" });
  } catch (err) {
    console.warn(`[chart-refresh] scheduled refresh of ${bindingId} failed: ${err.message}`);
  }
}

function unschedule(bindingId) {
  const job = timers.get(bindingId);
  if (job) {
    job.cancel();
    timers.delete(bindingId);
  }
}

// Rebuild every timer from the current table. Called at boot and after any
// mutation that can change which bindings exist or what their rules are —
// bindings number in the tens, so rebuilding beats tracking deltas.
export function syncSchedules() {
  const wanted = new Map();
  for (const binding of db.listChartBindingsWithRefs()) {
    // An unreferenced binding is never replayed (its user deleted the chart);
    // the sweeper removes it outright.
    if (!binding.refCount) continue;
    const rule = ruleOf(binding);
    if (rule) wanted.set(binding.id, rule);
  }
  for (const id of [...timers.keys()]) {
    if (!wanted.has(id)) unschedule(id);
  }
  for (const [id, rule] of wanted) {
    const existing = timers.get(id);
    if (existing) {
      if (existing.__rule === `${rule.cron}|${rule.tz}`) continue;
      unschedule(id);
    }
    const spec = rule.tz ? { rule: rule.cron, tz: rule.tz } : rule.cron;
    const job = schedule.scheduleJob(spec, () => runScheduled(id));
    if (job) {
      job.__rule = `${rule.cron}|${rule.tz}`;
      timers.set(id, job);
    } else {
      console.warn(`[chart-refresh] invalid cron rule for binding ${id}: ${rule.cron}`);
    }
  }
  return { scheduled: timers.size };
}

// ── Retention sweeper ────────────────────────────────────────────────────────

// Three jobs, all bounded: age out the refresh log and superseded unchanged
// observations, remove bindings nothing references (with their history), and
// trim every latest view to the period cap. Point revisions that CHANGED a
// value are never pruned while their binding is referenced.
export function sweepOnce({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const prunedRefreshes = db.pruneRefreshLog(cutoff);
  const prunedPoints = db.pruneUnchangedRevisions(cutoff);
  let removedBindings = 0;
  for (const binding of db.listChartBindingsWithRefs()) {
    if (binding.refCount) {
      db.trimSeriesPointsToCap(binding.id, PERIOD_CAP);
      continue;
    }
    db.deleteBindingHistory(binding.id);
    unschedule(binding.id);
    removedBindings += 1;
  }
  return { prunedRefreshes, prunedPoints, removedBindings };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function initChartRefresh({ broadcast: broadcastFn, ownerEmail = null, fetch: fetchFn = null } = {}) {
  if (broadcastFn) broadcast = broadcastFn;
  if (fetchFn) fetchImpl = fetchFn;
  if (typeof ownerEmail === "function") ownerEmailSource = ownerEmail;
  else if (ownerEmail !== null) ownerEmailSource = () => ownerEmail;
  // Whoever starts the scheduler owns resyncing it: attach/detach/delete and
  // rule changes go through the binding module's hook, which lands here.
  bindings.setSchedulerHook(() => syncSchedules());
  const { scheduled } = syncSchedules();
  const swept = sweepOnce();
  // Daily, at an hour nobody is watching a chart; boot runs it once already.
  sweeperTimer = schedule.scheduleJob("17 4 * * *", () => {
    try {
      sweepOnce();
    } catch (err) {
      console.warn(`[chart-refresh] sweeper failed: ${err.message}`);
    }
  });
  if (scheduled || swept.removedBindings) {
    console.log(
      `[chart-refresh] ${scheduled} binding timer(s); sweeper removed ${swept.removedBindings} unreferenced binding(s)`
    );
  }
  return { scheduled, ...swept };
}

export function shutdownChartRefresh() {
  for (const id of [...timers.keys()]) unschedule(id);
  if (sweeperTimer) {
    sweeperTimer.cancel();
    sweeperTimer = null;
  }
}

// Wiring used by the declared channel's route and the REST mutations.
export function setOwnerEmailSource(fn) {
  if (typeof fn === "function") ownerEmailSource = fn;
}

export function refreshBindingById(bindingId, options) {
  return refreshBinding(bindingId, { ...options, ownerEmail: undefined });
}