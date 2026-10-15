// Binding identity, origin priority, candidate retention, witness inference,
// and the REST surface (openspec: add-chart-data-binding, tasks 2.1-2.5).
//
// The capture funnel is exercised through `captureFromMessage` with the same
// turn-block shape dsh-events records, so inference and candidate retention are
// asserted on the real path rather than on a hand-built resource.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "chart-bindings-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");

const express = (await import("express")).default;
const db = await import("../db.js");
const bindings = await import("../chart-bindings.js");
const resources = await import("../resources.js");
const refresh = await import("../chart-refresh.js");
const _source = await import("../chart-source.js");
const { registerResourceRoutes } = await import("../server/routes/resources.js");

await db.initDb();
assert.ok(db.isDbReady());

const WORKSPACE = path.join(tmpRoot, "workspace");
await writeFile(path.join(tmpRoot, "placeholder"), "");
const events = [];
const app = express();
app.use(express.json());
await resources.initStore({ broadcast: (msg) => events.push(msg) });
registerResourceRoutes({ app, db, dshBridge: { getCwd: () => WORKSPACE } });
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

function call(method, route, body) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: route,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* non-JSON body */
            }
            resolve({ status: res.statusCode, json, text });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

after(() => {
  refresh.shutdownChartRefresh();
});

// ── fixtures ────────────────────────────────────────────────────────────────

const M0_ROWS = [
  { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
  { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
  { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
];

const readSeriesResult = (points = M0_ROWS) => ({
  concept_id: "M0_YOY",
  entity_type: "country",
  entity_id: "CN",
  start: points[0]?.date,
  end: points[points.length - 1]?.date,
  count: points.length,
  points,
});

const readSeriesBlock = (points = M0_ROWS) => ({
  kind: "tool",
  id: "call-1",
  name: "mcp__fd-open-data-mcp__read_series",
  args: { concept_id: "M0_YOY", entity_type: "country", entity_id: "CN" },
  result: JSON.stringify(readSeriesResult(points)),
  state: "done",
});

// A captured chart whose series values ARE the fixture's — the witness case.
const M0_OPTION = {
  title: { text: "M0 同比" },
  xAxis: { type: "category", data: ["2026-01", "2026-02", "2026-03"] },
  yAxis: { type: "value" },
  series: [{ name: "M0", type: "line", data: [7.1, 6.6, 6.9] }],
};

// `tag` makes a test's call identity its own. Binding identity is the lineage
// of (server, tool, args, map) — deliberately shared across charts — so without
// a tag two unrelated tests would share one binding row (and one refresh log).
// The sharing case is asserted explicitly, with one tag used twice.
function captureChart({ option = M0_OPTION, blocks = null, sessionId = "sess-1", tag = null } = {}) {
  const tagged =
    blocks && tag
      ? blocks.map((b) => (b.kind === "tool" ? { ...b, args: { ...(b.args ?? {}), tag } } : b))
      : blocks;
  const created = resources.captureFromMessage({
    sessionId,
    messageId: 1,
    sessionTitle: "绑定测试",
    text: `图表如下：\n\n\`\`\`echarts\n${JSON.stringify(option)}\n\`\`\``,
    blocks: tagged,
  });
  return created[0] ?? db.findResourceByHash(sha(option));
}

import { createHash } from "node:crypto";
function sha(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

// ── 2.1 identity, priority, snapshot ────────────────────────────────────────

test("lineage identity is content-derived: key order and whitespace do not change it", () => {
  const a = bindings.lineageKey({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY", entity_type: "country" },
    map: { rows: "points[]", period: "date", value: "value", source: "source_used", series: null },
  });
  const b = bindings.lineageKey({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { entity_type: "country", concept_id: "M0_YOY" },
    map: { source: "source_used", series: null, value: "value", period: "date", rows: "points[]" },
  });
  assert.equal(a, b);
  const differentArgs = bindings.lineageKey({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M1_YOY" },
    map: { rows: "points[]", period: "date", value: "value", source: "source_used", series: null },
  });
  assert.notEqual(a, differentArgs);
  const differentMap = bindings.lineageKey({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY", entity_type: "country" },
    map: { rows: "@root", period: "date", value: "value", source: "source_used", series: null },
  });
  assert.notEqual(a, differentMap, "the mapping is part of what the source IS");
});

test("two charts over one data call share one binding row and one history", async () => {
  const optionA = { ...M0_OPTION, title: { text: "A" } };
  const optionB = { ...M0_OPTION, title: { text: "B" } };
  const chartA = captureChart({ option: optionA, tag: "share" });
  const chartB = captureChart({ option: optionB, tag: "share" });
  const attach = (resourceId) =>
    bindings.attachBinding({
      resourceId,
      seriesIndex: 0,
      server: "fd-open-data-mcp",
      tool: "read_series",
      args: { concept_id: "M0_YOY" },
      origin: "confirmed",
      concept: "M0_YOY",
      frequency: "monthly",
      unit: "%",
    });
  const first = attach(chartA.id);
  const second = attach(chartB.id);
  assert.equal(first.binding.id, second.binding.id, "one row, shared by identity");
  assert.equal(second.created, false);
  assert.equal(db.listChartBindingsWithRefs().filter((b) => b.id === first.binding.id)[0].refCount, 2);

  // ...and a refresh of the shared row serves both charts.
  const rows = db.listSeriesPoints(first.binding.id);
  assert.equal(rows.length, 0, "nothing stored before the first refresh");
});

test("origin priority: a lower source cannot replace a higher one", () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "priority" } }, tag: "priority" });
  bindings.attachBinding({
    resourceId: chart.id,
    seriesIndex: 0,
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY", note: "declared-first" },
    origin: "declared",
    concept: "M0_YOY",
    frequency: "monthly",
  });
  // Inferred over declared → refused.
  assert.throws(
    () =>
      bindings.attachBinding({
        resourceId: chart.id,
        seriesIndex: 0,
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: { concept_id: "M0_YOY", note: "inferred-later" },
        origin: "inferred",
        concept: "M0_YOY",
        frequency: "monthly",
      }),
    (err) => err.code === "origin_downgrade"
  );
  // Confirmed over declared → refused too.
  assert.throws(
    () =>
      bindings.attachBinding({
        resourceId: chart.id,
        seriesIndex: 0,
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: { concept_id: "M0_YOY", note: "confirmed-later" },
        origin: "confirmed",
        concept: "M0_YOY",
        frequency: "monthly",
      }),
    (err) => err.code === "origin_downgrade"
  );
  // A declaration over a declaration replaces it.
  const replaced = bindings.attachBinding({
    resourceId: chart.id,
    seriesIndex: 0,
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY", note: "declared-again" },
    origin: "declared",
    concept: "M0_YOY",
    frequency: "monthly",
  });
  assert.ok(replaced.replaced);
  assert.equal(resources.get(chart.id).bindings[0].origin, "declared");
});

test("a binding records the concept/frequency/unit snapshot at attach", () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "snapshot" } }, tag: "snapshot" });
  const { binding } = bindings.attachBinding({
    resourceId: chart.id,
    seriesIndex: 0,
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY" },
    origin: "confirmed",
    concept: "M0_YOY",
    frequency: "monthly",
    unit: "%",
  });
  assert.equal(binding.frequency, "monthly");
  assert.equal(binding.unit, "%");
  assert.equal(binding.concept, "M0_YOY");
  // Frequency is required: normalization under a guessed cadence corrupts data.
  assert.throws(
    () =>
      bindings.attachBinding({
        resourceId: chart.id,
        seriesIndex: 1,
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: { concept_id: "M0_YOY" },
        origin: "confirmed",
        frequency: null,
      }),
    (err) => err.code === "unsupported_frequency"
  );
});

test("non-bindable tools and unknown servers are refused", () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "scope" } }, tag: "scope" });
  assert.throws(
    () =>
      bindings.attachBinding({
        resourceId: chart.id,
        server: "fd-open-data-mcp",
        tool: "policy_delete",
        origin: "declared",
        frequency: "monthly",
      }),
    (err) => err.code === "unsupported_tool"
  );
  assert.throws(
    () =>
      bindings.attachBinding({
        resourceId: chart.id,
        server: "some-other-mcp",
        tool: "read_series",
        origin: "declared",
        frequency: "monthly",
      }),
    (err) => err.code === "unsupported_server"
  );
});

// ── 2.2 candidate retention ─────────────────────────────────────────────────

test("the capture funnel retains same-turn MCP calls as candidates, and only those", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "candidates" } },
    tag: "candidates",
    blocks: [
      { kind: "text", text: "分析如下" },
      { kind: "tool", id: "c1", name: "Bash", args: { command: "ls" }, result: "a.txt" },
      { kind: "tool", id: "c2", name: "mcp__other-server__search", args: { q: "x" }, result: "[]" },
      readSeriesBlock(),
    ],
  });
  const stored = db.getResourceCandidates(chart.id);
  // Every same-turn MCP call is RETAINED (the design's candidate rule);
  // what is not bindable is filtered when offered, not when captured.
  assert.deepEqual(stored.map((c) => c.name).sort(), [
    "mcp__fd-open-data-mcp__read_series",
    "mcp__other-server__search",
  ]);
  const readSeriesCandidate = stored.find((c) => c.name.endsWith("read_series"));
  assert.deepEqual(readSeriesCandidate.args, {
    concept_id: "M0_YOY",
    entity_type: "country",
    entity_id: "CN",
    tag: "candidates",
  });
  assert.ok(readSeriesCandidate.result.includes("M0_YOY"));
});

test("a chart with no MCP calls captures exactly as before", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "no-tools" } },
    tag: "no-tools",
    blocks: [{ kind: "tool", id: "c1", name: "web_search", args: { q: "M0" }, result: "…" }],
  });
  assert.ok(chart, "the chart is captured");
  assert.deepEqual(db.getResourceCandidates(chart.id), []);
  assert.deepEqual(resources.get(chart.id).bindings, []);
});

test("candidates merge across captures and re-runs replace the same call's result", () => {
  const option = { ...M0_OPTION, title: { text: "merge" } };
  const first = captureChart({ option, blocks: [readSeriesBlock()], tag: "merge" });
  // A regenerated turn: the same call, a newer result, plus a second call.
  captureChart({
    option,
    tag: "merge",
    blocks: [
      { ...readSeriesBlock([...M0_ROWS, { date: "2026-04-01", value: 7.4, unit: "%", source_used: "pboc" }]) },
      { kind: "tool", id: "c9", name: "mcp__fd-open-data-mcp__data_stats", args: { concept_id: "M0_YOY" }, result: '{"rows":4}' },
    ],
  });
  const stored = db.getResourceCandidates(first.id);
  assert.equal(stored.length, 2);
  const readSeries = stored.find((c) => c.name.endsWith("read_series"));
  assert.ok(readSeries.result.includes("2026-04-01"), "the newest result for an identity wins");
});

test("a candidate result over the cap is truncated at capture", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "cap" } },
    tag: "cap",
    blocks: [{ kind: "tool", id: "c1", name: "mcp__fd-open-data-mcp__read_series", args: {}, result: "x".repeat(300 * 1024) }],
  });
  const [stored] = db.getResourceCandidates(chart.id);
  assert.equal(stored.result.length, 200 * 1024);
});

test("the candidate list offers the exact call with its proposed map, and hides noise", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "offer" } },
    tag: "offer",
    blocks: [readSeriesBlock(), { kind: "tool", id: "c1", name: "Bash", args: {}, result: "x" }],
  });
  const offered = bindings.candidatesForResource(db.getResource(chart.id));
  assert.equal(offered.length, 1);
  assert.equal(offered[0].server, "fd-open-data-mcp");
  assert.equal(offered[0].tool, "read_series");
  assert.equal(offered[0].allowlisted, true);
  assert.equal(offered[0].frequency, "monthly");
  assert.equal(offered[0].unit, "%");
  assert.equal(offered[0].points, 3);
  assert.equal(offered[0].matchedSeries, 0);
  assert.deepEqual(offered[0].args, {
    concept_id: "M0_YOY",
    entity_type: "country",
    entity_id: "CN",
    tag: "offer",
  });
});

// ── 2.3 witness inference ───────────────────────────────────────────────────

test("a unique witness binds the chart at capture with origin inferred", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "inferred" } },
    tag: "inferred",
    blocks: [readSeriesBlock()],
  });
  const attached = resources.get(chart.id).bindings;
  assert.equal(attached.length, 1, "capture inferred a binding");
  assert.equal(attached[0].origin, "inferred");
  assert.equal(attached[0].server, "fd-open-data-mcp");
  assert.equal(attached[0].tool, "read_series");
  assert.equal(attached[0].frequency, "monthly");
  assert.equal(attached[0].unit, "%");
  assert.equal(attached[0].seriesIndex, 0);
});

test("zero matches means no inference, and the chart stays confirmable", () => {
  const chart = captureChart({
    // The chart's numbers are NOT the call's numbers.
    option: { ...M0_OPTION, title: { text: "witness-zero" }, series: [{ name: "M0", type: "line", data: [1, 2, 3] }] },
    tag: "witness-zero",
    blocks: [readSeriesBlock()],
  });
  assert.deepEqual(resources.get(chart.id).bindings, []);
  assert.equal(bindings.candidatesForResource(db.getResource(chart.id)).length, 1, "still offered for confirmation");
});

test("multiple matching candidates mean no inference", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "ambiguous" } },
    tag: "ambiguous",
    blocks: [
      readSeriesBlock(),
      { kind: "tool", id: "c2", name: "mcp__fd-open-data-mcp__read", args: { concept_id: "M0_YOY" }, result: JSON.stringify(M0_ROWS) },
    ],
  });
  // Both candidates witness series 0 identically → ambiguous → nothing bound.
  assert.deepEqual(resources.get(chart.id).bindings, []);
});

test("a yearly chart witnesses its year-end labels, and the duplicate defect still infers", () => {
  const option = {
    title: { text: "GDP" },
    xAxis: { type: "category", data: ["2022", "2023"] },
    series: [{ name: "GDP", type: "bar", data: [121.0, 126.1] }],
  };
  const chart = captureChart({
    option,
    tag: "yearly",
    blocks: [
      {
        kind: "tool",
        id: "c1",
        name: "mcp__fd-open-data-mcp__read_series",
        args: { concept_id: "GDP_NOMINAL" },
        result: JSON.stringify({
          concept_id: "GDP_NOMINAL",
          points: [
            { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
            { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
            { date: "2023-12-31", value: 126.1, unit: "亿元", source_used: "stats" },
          ],
        }),
      },
    ],
  });
  const attached = resources.get(chart.id).bindings;
  assert.equal(attached.length, 1);
  assert.equal(attached[0].frequency, "yearly");
  assert.equal(attached[0].unit, "亿元");
});

test("inference never overrides a declared or confirmed binding", () => {
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "no-override" } },
    tag: "no-override",
    blocks: [readSeriesBlock()],
  });
  // The capture already inferred one; a confirmation replaces it...
  const originBefore = resources.get(chart.id).bindings[0].origin;
  assert.equal(originBefore, "inferred");
  // The user confirms the retained candidate: the exact recorded call.
  const [candidate] = db.getResourceCandidates(chart.id);
  const moved = bindings.attachBinding({
    resourceId: chart.id,
    seriesIndex: 0,
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: candidate.args,
    origin: "confirmed",
    concept: "M0_YOY",
    frequency: "monthly",
    unit: "%",
  });
  assert.equal(resources.get(chart.id).bindings[0].origin, "confirmed");
  assert.equal(moved.binding.id, moved.replaced, "the same identity row was already there");

  // ...and a re-run's inference cannot take it back.
  const again = bindings.inferBindings({
    resourceId: chart.id,
    option: M0_OPTION,
    candidates: db.getResourceCandidates(chart.id),
  });
  assert.equal(again.attached.length, 0);
  assert.equal(resources.get(chart.id).bindings[0].origin, "confirmed");
});

// ── 2.5 the REST surface ────────────────────────────────────────────────────

test("the resource list carries binding views with stale state and refreshability", async () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "rest-list" } }, blocks: [readSeriesBlock()], tag: "rest-list" });
  const res = await call("GET", "/api/resources?type=chart");
  assert.equal(res.status, 200);
  const item = res.json.items.find((r) => r.id === chart.id);
  assert.equal(Array.isArray(item.bindings), true);
  assert.equal(item.bindings.length, 1);
  assert.deepEqual(item.bindingRefs, [{ seriesIndex: 0, bindingId: item.bindings[0].id }]);
  assert.equal(item.bindings[0].refreshable, true);
  assert.equal(item.bindings[0].stale, false);
  assert.equal(item.bindings[0].staleReason, null);
  assert.equal(item.bindings[0].periods, 0);
});

test("attach-from-candidate, refresh, set rule, observations, as-of and detach round-trip", async () => {
  // A chart whose numbers do not witness the call, so nothing is inferred.
  const chart = captureChart({
    option: { ...M0_OPTION, title: { text: "rest-flow" }, series: [{ name: "M0", type: "line", data: [1, 2, 3] }] },
    tag: "rest-flow",
    blocks: [readSeriesBlock()],
  });
  const listed = await call("GET", `/api/resources/${chart.id}/candidates`);
  assert.equal(listed.json.candidates.length, 1);

  const attached = await call("POST", `/api/resources/${chart.id}/bindings`, { candidateIndex: 0 });
  assert.equal(attached.status, 200, attached.text);
  assert.equal(attached.json.binding.origin, "confirmed");
  assert.equal(attached.json.binding.unit, "%");
  const bindingId = attached.json.binding.id;

  // No MCP server is installed in this test, so the refresh fails with a
  // recorded reason — and that is the point: the endpoint reports outcomes.
  const refreshed = await call("POST", `/api/resources/${chart.id}/bindings/${bindingId}/refresh`, {});
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.ok, false);
  assert.equal(refreshed.json.reason, "unreachable");
  assert.equal(refreshed.json.resource.bindings[0].stale, true);
  assert.equal(refreshed.json.resource.bindings[0].staleReason, "unreachable");

  const rule = await call("PATCH", `/api/resources/${chart.id}/bindings/${bindingId}/refresh-rule`, {
    refreshRule: { cron: "0 9 * * *", tz: "Asia/Shanghai" },
  });
  assert.equal(rule.status, 200, rule.text);
  assert.deepEqual(rule.json.binding.refreshRule, { cron: "0 9 * * *", tz: "Asia/Shanghai" });
  const badRule = await call("PATCH", `/api/resources/${chart.id}/bindings/${bindingId}/refresh-rule`, {
    refreshRule: { cron: "nonsense" },
  });
  assert.equal(badRule.status, 400);

  const timeline = await call("GET", `/api/resources/${chart.id}/observations?limit=10`);
  assert.equal(timeline.status, 200);
  assert.equal(timeline.json.items.length, 1);
  assert.equal(timeline.json.items[0].bindingId, bindingId);
  assert.equal(timeline.json.items[0].outcome, "error");
  assert.equal(timeline.json.items[0].trigger, "manual");
  assert.match(timeline.json.items[0].error, /not installed|unreachable/i);

  const asOf = await call("GET", `/api/resources/${chart.id}/as-of?at=${encodeURIComponent(new Date().toISOString())}`);
  assert.equal(asOf.status, 404, "no observations yet → nothing to reconstruct");
  const badAt = await call("GET", `/api/resources/${chart.id}/as-of?at=yesterday`);
  assert.equal(badAt.status, 400);

  const detached = await call("DELETE", `/api/resources/${chart.id}/bindings/${bindingId}`);
  assert.equal(detached.status, 200);
  assert.equal(detached.json.resource.bindings.length, 0);
  assert.equal(detached.json.detached, true);
});

test("binding mutations broadcast the library-change event", async () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "broadcast" } }, blocks: [readSeriesBlock()], tag: "broadcast" });
  events.length = 0;
  const attached = await call("POST", `/api/resources/${chart.id}/bindings`, { candidateIndex: 0 });
  const bindingId = attached.json.binding.id;
  const actions = events.filter((e) => e.type === "resources_changed").map((e) => e.action);
  assert.ok(actions.includes("bound"));
  events.length = 0;
  await call("DELETE", `/api/resources/${chart.id}/bindings/${bindingId}`);
  assert.deepEqual(
    events.filter((e) => e.type === "resources_changed").map((e) => e.action),
    ["unbound"]
  );
});

test("an unknown resource or binding is a 404, and a bad map is a 400", async () => {
  assert.equal((await call("GET", "/api/resources/nope/candidates")).status, 404);
  assert.equal((await call("POST", "/api/resources/nope/bindings", { candidateIndex: 0 })).status, 404);
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "errors" } }, blocks: [readSeriesBlock()], tag: "errors" });
  assert.equal((await call("DELETE", `/api/resources/${chart.id}/bindings/nope`)).status, 404);
  const badMap = await call("POST", `/api/resources/${chart.id}/bindings`, {
    candidate: { server: "fd-open-data-mcp", tool: "read_series", args: {} },
    map: { rows: "points[]", period: "date", value: "value", source: "source_used", filter: "x" },
    frequency: "monthly",
  });
  assert.equal(badMap.status, 400);
  assert.match(badMap.json.error, /unknown map field/);
});

test("the on-open trigger respects the TTL and records nothing when fresh", async () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "ttl" } }, blocks: [readSeriesBlock()], tag: "ttl" });
  const attached = await call("POST", `/api/resources/${chart.id}/bindings`, { candidateIndex: 0 });
  const bindingId = attached.json.binding.id;
  await call("PATCH", `/api/resources/${chart.id}/bindings/${bindingId}/refresh-rule`, {
    refreshRule: { ttlSec: 3600 },
  });
  // No successful observation has happened, so there is no "fresh" state: the
  // open trigger falls through to the read attempt (and fails: no server).
  const first = await call("POST", `/api/resources/${chart.id}/bindings/${bindingId}/refresh`, { trigger: "on-open" });
  assert.equal(first.json.ok, false);
  // With a recorded successful read inside the TTL, the open trigger is a no-op.
  db.updateChartBinding(bindingId, { lastOkAt: new Date().toISOString(), stale: false }, new Date().toISOString());
  const second = await call("POST", `/api/resources/${chart.id}/bindings/${bindingId}/refresh`, { trigger: "on-open" });
  assert.equal(second.json.ok, true);
  assert.equal(second.json.reason, "ttl");
  assert.equal(second.json.outcome, "skipped_fresh");
  // ...and it is not logged: opening a chart is not an observation attempt.
  const timeline = await call("GET", `/api/resources/${chart.id}/observations`);
  assert.equal(timeline.json.items.length, 1);
});

test("a refresh through HTTP writes points, moves the payload and serves as-of", async () => {
  const { createFakeMcp } = await import("../e2e/fake-mcp.js");
  const extensionStore = await import("../extension-store.js");
  const registryCredentials = await import("../registry-credentials.js");
  const TOKEN = "bindings-rest-token";
  const fake = createFakeMcp({ token: TOKEN });
  const url = await fake.listen();
  extensionStore.addMcpServer({ name: "fd-open-data-mcp", config: { url, credentialRef: "registry" } });
  registryCredentials.store({ email: null, token: TOKEN, source: "paste" });
  refresh.setOwnerEmailSource(() => null);
  try {
    const chart = captureChart({
      option: { ...M0_OPTION, title: { text: "rest-refresh" }, series: [{ name: "M0", type: "line", data: [1, 2, 3] }] },
      tag: "rest-refresh",
      blocks: [readSeriesBlock()],
    });
    const attached = await call("POST", `/api/resources/${chart.id}/bindings`, { candidateIndex: 0 });
    const bindingId = attached.json.binding.id;

    const before = Date.now();
    const refreshed = await call("POST", `/api/resources/${chart.id}/bindings/${bindingId}/refresh`, {});
    assert.equal(refreshed.json.ok, true, JSON.stringify(refreshed.json));
    assert.deepEqual(refreshed.json.counts, { appended: 3, revised: 0, resourced: 0, unchanged: 0, missing: 0 });
    const binding = refreshed.json.resource.bindings[0];
    assert.equal(binding.stale, false);
    assert.equal(binding.periods, 3);
    assert.ok(Date.parse(binding.lastObservedAt) >= before);
    assert.ok(binding.lastOkAt);
    const payload = JSON.parse(refreshed.json.resource.payload);
    assert.deepEqual(payload.series[0].data, [7.1, 6.6, 6.9]);
    assert.deepEqual(payload.xAxis.data, ["2026-01", "2026-02", "2026-03"]);
    assert.deepEqual(payload.title, { text: "rest-refresh" }, "the frozen template kept its non-data fields");

    const timeline = await call("GET", `/api/resources/${chart.id}/observations`);
    assert.equal(timeline.json.items[0].outcome, "ok");
    assert.equal(timeline.json.items[0].added, 3);

    // The as-of view of the moment just after the refresh: the same data.
    const at = new Date().toISOString();
    const asOf = await call("GET", `/api/resources/${chart.id}/as-of?at=${encodeURIComponent(at)}`);
    assert.equal(asOf.status, 200);
    assert.deepEqual(asOf.json.option.series[0].data, [7.1, 6.6, 6.9]);
    assert.equal(asOf.json.periods, 3);

    // Before anything was observed: nothing to reconstruct.
    const early = await call("GET", `/api/resources/${chart.id}/as-of?at=${encodeURIComponent("2020-01-01T00:00:00.000Z")}`);
    assert.equal(early.status, 404);
  } finally {
    await fake.close();
    db.getDb().prepare("DELETE FROM extension_configs WHERE name = ?").run("fd-open-data-mcp");
  }
});

test("binding candidates survive on the resource but are not part of list responses", async () => {
  const chart = captureChart({ option: { ...M0_OPTION, title: { text: "payload-size" } }, blocks: [readSeriesBlock()], tag: "payload-size" });
  const res = await call("GET", "/api/resources?q=payload-size");
  const item = res.json.items[0];
  assert.equal(item.id, chart.id);
  assert.equal("bindingCandidates" in item, false, "the candidate blob stays out of list responses");
  assert.ok(db.getResourceCandidates(chart.id).length === 1);
});