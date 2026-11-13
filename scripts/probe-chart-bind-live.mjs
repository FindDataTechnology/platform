#!/usr/bin/env node
// ── Live probe: chart data binding against the real fd-open-data-mcp ─────────
// (openspec: add-chart-data-binding, task 6.3)
//
// Drives the WHOLE refresh loop against the live upstream — resolve the
// endpoint from an installed extension config, call `read_series` for a real
// monthly concept, map and normalize, classify against the store, write the
// point rows, regenerate the chart payload, log the refresh — and prints a
// transcript of every step so the change notes can carry it.
//
// Two modes:
//   * local (default): a scratch DB and store, the real upstream over the
//     tailnet. Proves the upstream integration without deploying anything.
//   * live cell (`CHART_PROBE_CELL=http://host:port`): the same assertions
//     against a DEPLOYED cell, through its REST surface on a chart the probe
//     creates there.
//
// Usage:
//   node scripts/probe-chart-bind-live.mjs
//   CHART_PROBE_MCP_URL=http://chengsi:30899/mcp CHART_PROBE_CONCEPT_CODE=M0_YOY \
//     node scripts/probe-chart-bind-live.mjs
//   CHART_PROBE_CELL=https://craw.example.cloud node scripts/probe-chart-bind-live.mjs
//
// The registry transport (what a deployed cell uses) takes the MINTED per-user
// token — the service token is refused there with 401. Mint one through the
// connect flow (see scripts/verify-registry-connect-live.mjs) and pass it:
//   CHART_PROBE_MCP_URL=$REGISTRY_URL/fd-open-data-mcp/mcp \
//     CHART_PROBE_REGISTRY_TOKEN=<minted token> node scripts/probe-chart-bind-live.mjs

import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MCP_URL = (process.env.CHART_PROBE_MCP_URL || "http://chengsi:30899/mcp").replace(/\/$/, "");
// The live call shape (discovered 2026-09-28 against fd-open-data-mcp v4.0.5 on
// the tailnet): concept_id and entity_id are INTEGERS, and start/end are
// REQUIRED. The window is part of the call the binding records, which is what
// keeps a refresh reading the same window forever (revisions accumulate inside
// it; the stored series grows by accumulation, not by widening the window).
const CONCEPT_CODE = process.env.CHART_PROBE_CONCEPT_CODE || "M0_YOY";
const CONCEPT = Number(process.env.CHART_PROBE_CONCEPT || 228);
const ENTITY_TYPE = process.env.CHART_PROBE_ENTITY_TYPE || "country";
const ENTITY_ID = Number(process.env.CHART_PROBE_ENTITY_ID || 1);
const START = process.env.CHART_PROBE_START || "2024-01-01";
const END = process.env.CHART_PROBE_END || "2026-12-31";
const FREQUENCY = process.env.CHART_PROBE_FREQUENCY || "monthly";
const YEARLY_CONCEPT = Number(process.env.CHART_PROBE_YEARLY_CONCEPT || 0);
const CELL = (process.env.CHART_PROBE_CELL || "").replace(/\/$/, "");
const TOKEN = process.env.CHART_PROBE_REGISTRY_TOKEN || "";

const steps = [];
function ok(label, detail = "") {
  steps.push({ ok: true, label, detail });
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail = "") {
  steps.push({ ok: false, label, detail });
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

if (CELL) {
  await probeLiveCell();
} else {
  await probeLocal();
}

console.log(`\n── transcript ──`);
for (const step of steps) console.log(`${step.ok ? "✓" : "✗"} ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
console.log(process.exitCode ? "\nPROBE FAILED" : "\nPROBE OK");

// ── local mode: the real upstream, a scratch cell ───────────────────────────

async function probeLocal() {
  const root = mkdtempSync(path.join(tmpdir(), "chart-probe-"));
  process.env.DB_PATH = path.join(root, "app.db");
  process.env.RESOURCES_STORAGE_PATH = path.join(root, "resources-store");

  const db = await import("../db.js");
  const extensionStore = await import("../extension-store.js");
  const registryCredentials = await import("../registry-credentials.js");
  const resources = await import("../resources.js");
  const chartRefresh = await import("../chart-refresh.js");
  const source = await import("../chart-source.js");

  await db.initDb();
  if (!db.isDbReady()) return bad("open a scratch database");
  ok("scratch cell opened", root);

  extensionStore.addMcpServer({
    name: "fd-open-data-mcp",
    config: TOKEN ? { url: MCP_URL, credentialRef: "registry" } : { url: MCP_URL },
  });
  if (TOKEN) registryCredentials.store({ email: null, token: TOKEN, source: "paste" });
  ok("upstream installed", `${MCP_URL}${TOKEN ? " with the registry credential" : " (no credential needed on this port)"}`);

  chartRefresh.setOwnerEmailSource(() => null);
  const events = [];
  await resources.initStore({ broadcast: (msg) => events.push(msg) });
  chartRefresh.setBroadcast((msg) => events.push(msg));

  // 0. concept discovery, when a code is given: ai_search is the live metadata
  //    surface (list_concepts is BROKEN upstream — it forwards an unsupported
  //    `query` kwarg — which is exactly why a binding derives its cadence from
  //    the chart's own labels instead of asking the source).
  if (CONCEPT_CODE) {
    try {
      const found = await source.callTool({
        server: "fd-open-data-mcp",
        tool: "ai_search",
        args: { query: CONCEPT_CODE, limit: 5 },
        ownerEmail: null,
      });
      const concept = (found?.concepts ?? []).find((c) => c.code === CONCEPT_CODE);
      if (concept) {
        ok(
          `concept discovered: ${concept.code} (id ${concept.id})`,
          `${concept.name_zh ?? concept.name_en ?? ""} · unit=${concept.unit} · frequency=${concept.frequency} · entity=${concept.entity_type}`
        );
      } else {
        bad(`concept ${CONCEPT_CODE} not found by ai_search`, `${(found?.concepts ?? []).length} results`);
      }
    } catch (err) {
      bad("concept discovery (ai_search)", err.message);
    }
  }
  const callArgs = { concept_id: CONCEPT, entity_type: ENTITY_TYPE, entity_id: ENTITY_ID, start: START, end: END };

  // 1. the read tool's real shape
  let result;
  try {
    result = await source.callTool({
      server: "fd-open-data-mcp",
      tool: "read_series",
      args: callArgs,
      ownerEmail: null,
    });
  } catch (err) {
    return bad("read_series against the live upstream", err.message);
  }
  const points = Array.isArray(result?.points) ? result.points : [];
  ok(
    "read_series returned the probed object shape",
    `concept_id=${result.concept_id} entity=${result.entity_id} count=${result.count} first=${JSON.stringify(points[0])}`
  );
  if (!points.length) return bad("the live response carried no points");
  if (points[0].date === undefined || points[0].value === undefined || points[0].source_used === undefined) {
    return bad("the live row shape differs from the design's", JSON.stringify(Object.keys(points[0])));
  }

  // 2. the freshness gate's shape
  const fingerprint = await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: String(CONCEPT), ownerEmail: null });
  fingerprint
    ? ok("data_stats gate readable", `fingerprint=${fingerprint}`)
    : bad("data_stats gate unreadable (a refresh would then always read)");

  // 3. the mapping + normalization on the live payload
  const evaluated = source.evaluateMap(result, source.defaultMapForTool("read_series"), FREQUENCY);
  if (!evaluated.ok) return bad("map the live response", evaluated.reason);
  ok(
    "mapped and normalized",
    `${evaluated.points.length} points, ${evaluated.points[0].period}..${evaluated.points[evaluated.points.length - 1].period}, unit=${[...evaluated.units].join("/")}, anomalies=${evaluated.anomalies.length}`
  );

  // 4. a real chart + binding, then the whole refresh loop
  const periods = evaluated.points.map((point) => point.period);
  const option = {
    title: { text: `LIVE 探针 ${CONCEPT}` },
    xAxis: { type: "category", data: periods },
    yAxis: { type: "value" },
    series: [{ name: CONCEPT, type: "line", data: periods.map(() => null) }],
  };
  const payload = JSON.stringify(option);
  const now = new Date().toISOString();
  const { resource } = db.insertResource({
    id: crypto.randomUUID(),
    type: "chart",
    title: option.title.text,
    source: "auto",
    sessionTitle: "live probe",
    payload,
    contentHash: crypto.createHash("sha256").update(payload).digest("hex"),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  const binding = db.insertChartBinding({
    id: crypto.randomUUID(),
    lineageKey: crypto.createHash("sha256").update(`probe|${CONCEPT}|${now}`).digest("hex"),
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: callArgs,
    map: source.defaultMapForTool("read_series"),
    concept: String(CONCEPT),
    frequency: FREQUENCY,
    unit: null,
    origin: "declared",
    createdAt: now,
    updatedAt: now,
  });
  db.setResourceBindingRefs(resource.id, [{ seriesIndex: 0, bindingId: binding.id }], now);
  ok("chart bound (origin declared, unit recorded on the first read)", `resource=${resource.id.slice(0, 8)} binding=${binding.id.slice(0, 8)}`);

  const refresh = await chartRefresh.refreshBinding(binding.id, { trigger: "manual" });
  refresh.ok
    ? ok("manual refresh against the live upstream", `outcome=${refresh.outcome} counts=${JSON.stringify(refresh.counts)} anomalies=${refresh.anomalies?.length ?? 0}`)
    : bad("manual refresh against the live upstream", `${refresh.reason}: ${refresh.error ?? ""}`);

  const stored = db.listSeriesPoints(binding.id);
  stored.length === evaluated.points.length
    ? ok("point rows written", `${stored.length} rows, ${stored[0].period}..${stored[stored.length - 1].period}`)
    : bad("point rows written", `stored ${stored.length} of ${evaluated.points.length}`);

  const after = db.getResource(resource.id);
  const afterOption = JSON.parse(after.payload);
  const drawn = (afterOption.series?.[0]?.data ?? []).filter((v) => typeof v === "number").length;
  drawn === stored.length
    ? ok("payload regenerated through the frozen template", `${drawn} values, axis ${afterOption.xAxis.data.length}, title kept=${afterOption.title.text === option.title.text}`)
    : bad("payload regenerated", `${drawn} numeric values for ${stored.length} stored points`);

  const log = db.listChartRefreshes(binding.id, { limit: 1 });
  log.items.length && log.items[0].trigger === "manual" && log.items[0].outcome !== "error"
    ? ok("timeline entry written", `${log.items[0].trigger}/${log.items[0].outcome} added=${log.items[0].added} revised=${log.items[0].revised}`)
    : bad("timeline entry written", JSON.stringify(log.items[0] ?? null));

  const refreshedBinding = db.getChartBinding(binding.id);
  refreshedBinding.unit
    ? ok("unit recorded from the first observation", refreshedBinding.unit)
    : bad("unit recorded from the first observation", "no unit in the live response");
  events.some((e) => e.type === "resources_changed" && e.action === "refreshed")
    ? ok("clients were told to redraw (resources_changed/refreshed)")
    : bad("clients were told to redraw", JSON.stringify(events.slice(-2)));

  // 5. the scheduled path: the first tick records the gate fingerprint, the next
  //    one skips on it — the cheap path that keeps a bound chart from re-reading
  //    a window nothing has moved in.
  const firstTick = await chartRefresh.refreshBinding(binding.id, { trigger: "scheduled" });
  ok("scheduled tick 1", `outcome=${firstTick.outcome} (records the live gate fingerprint)`);
  const secondTick = await chartRefresh.refreshBinding(binding.id, { trigger: "scheduled" });
  secondTick.outcome === "skipped_fresh"
    ? ok("scheduled tick 2 skipped on the unchanged gate", "no series read was made")
    : bad("scheduled tick 2 skipped on the unchanged gate", `outcome=${secondTick.outcome}`);

  // 6. the yearly label defect, if a yearly concept is known
  if (YEARLY_CONCEPT) {
    try {
      const yearly = await source.callTool({
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: { concept_id: YEARLY_CONCEPT, entity_type: ENTITY_TYPE, entity_id: ENTITY_ID, start: "2015", end: "2026" },
        ownerEmail: null,
      });
      const mapped = source.evaluateMap(yearly, source.defaultMapForTool("read_series"), "yearly");
      if (!mapped.ok) {
        bad("map a yearly concept", mapped.reason);
      } else {
        const raw = (yearly.points ?? []).map((p) => p.date);
        const dupes = raw.length - new Set(raw.map((d) => source.normalizePeriod(d, "yearly"))).size;
        ok(
          `yearly concept ${YEARLY_CONCEPT}: ${raw.length} raw labels → ${mapped.points.length} normalized periods`,
          dupes > 0 ? `${dupes} duplicate representation(s) collapsed; anomalies=${mapped.anomalies.length}` : `labels: ${raw.slice(0, 4).join(", ")}…`
        );
        for (const anomaly of mapped.anomalies) {
          ok(`anomaly recorded for ${anomaly.period}`, JSON.stringify(anomaly.values));
        }
      }
    } catch (err) {
      bad(`yearly concept ${YEARLY_CONCEPT}`, err.message);
    }
  } else {
    console.log("· (set CHART_PROBE_YEARLY_CONCEPT to also exercise the yearly label defect)");
  }
}

// ── live-cell mode: the same assertions through a deployed cell ─────────────

async function probeLiveCell() {
  const api = async (method, route, body) => {
    const res = await fetch(`${CELL}${route}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text };
  };

  const ready = await api("GET", "/api/ready");
  ready.status === 200 ? ok("cell answers /api/ready", CELL) : bad("cell answers /api/ready", `HTTP ${ready.status}`);

  // A chart resource to bind: created through the library's own save path is
  // not possible (charts come from turns), so the probe lists what the cell
  // already has and refreshes the first BOUND chart it finds — that is the
  // end-to-end assertion without a model turn.
  const listed = await api("GET", "/api/resources?type=chart&limit=50");
  if (listed.status !== 200) return bad("list chart resources", `HTTP ${listed.status}`);
  const bound = (listed.json.items ?? []).filter((item) => (item.bindings ?? []).length);
  if (!bound.length) {
    return bad(
      "a bound chart exists on the cell",
      "none found — bind one from the resources page (or let a turn infer it), then re-run"
    );
  }
  ok("bound chart found", `${bound[0].title} (${bound[0].bindings.length} binding(s), ${bound[0].bindings[0].periods} periods)`);

  const item = bound[0];
  const binding = item.bindings[0];
  const refreshed = await api("POST", `/api/resources/${item.id}/bindings/${binding.id}/refresh`, { trigger: "manual" });
  if (refreshed.status !== 200) return bad("manual refresh through the cell", `HTTP ${refreshed.status}: ${refreshed.text.slice(0, 200)}`);
  refreshed.json.ok
    ? ok("manual refresh through the cell", `outcome=${refreshed.json.outcome} counts=${JSON.stringify(refreshed.json.counts)}`)
    : bad("manual refresh through the cell", `${refreshed.json.reason}: ${refreshed.json.error ?? ""}`);

  const after = refreshed.json.resource ?? {};
  const afterBinding = (after.bindings ?? []).find((b) => b.id === binding.id) ?? {};
  afterBinding.periods >= binding.periods
    ? ok("point rows grew or held", `${binding.periods} → ${afterBinding.periods} periods`)
    : bad("point rows grew or held", `${binding.periods} → ${afterBinding.periods}`);

  const option = after.payload ? JSON.parse(after.payload) : null;
  const values = (option?.series?.[0]?.data ?? []).filter((v) => typeof v === "number").length;
  values > 0
    ? ok("payload carries the stored series", `${values} values on ${option.xAxis.data.length} axis labels`)
    : bad("payload carries the stored series", JSON.stringify(option)?.slice(0, 200));

  const timeline = await api("GET", `/api/resources/${item.id}/observations?limit=3`);
  timeline.status === 200 && (timeline.json.items ?? []).length
    ? ok("timeline entry present", `${timeline.json.items[0].trigger}/${timeline.json.items[0].outcome} at ${timeline.json.items[0].fetchedAt}`)
    : bad("timeline entry present", `HTTP ${timeline.status} ${timeline.text.slice(0, 160)}`);

  const asOf = await api("GET", `/api/resources/${item.id}/as-of?at=${encodeURIComponent(new Date().toISOString())}`);
  asOf.status === 200 && asOf.json?.option
    ? ok("as-of reconstruction renders", `${asOf.json.periods} periods at ${asOf.json.at}`)
    : bad("as-of reconstruction renders", `HTTP ${asOf.status} ${asOf.text.slice(0, 160)}`);
}