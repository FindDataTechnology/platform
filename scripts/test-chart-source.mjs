// The chart data source: the replay client, the mapping contract, and
// frequency-aware normalization (openspec: add-chart-data-binding, tasks 1.2-1.3).
//
// The fake MCP (e2e/fake-mcp.js) mirrors the shapes the live upstream was
// probed to return, including its two observed defects — the yearly series that
// carries both `2023` and `2023-12-31` for one period, and its collision form —
// so every branch of the mapper is exercised against the real defect rather
// than a convenient fixture.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "chart-source-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const db = await import("../db.js");
const extensionStore = await import("../extension-store.js");
const registryCredentials = await import("../registry-credentials.js");
const source = await import("../chart-source.js");
const { createFakeMcp } = await import("../e2e/fake-mcp.js");

await db.initDb();
assert.ok(db.isDbReady());

const TOKEN = "chart-source-test-token";
const fake = createFakeMcp({ scenario: "monthly", framing: "sse", token: TOKEN });
const url = await fake.listen();
extensionStore.addMcpServer({
  name: "fd-open-data-mcp",
  config: { url, credentialRef: "registry" },
});
registryCredentials.store({ email: null, token: TOKEN, source: "paste" });

after(async () => {
  await fake.close();
});

// ── 1.2 the replay client ───────────────────────────────────────────────────

test("read_series over SSE: initialize → initialized → tools/call, parsed to the probed object shape", async () => {
  const result = await source.callTool({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY" },
    ownerEmail: null,
  });
  assert.equal(result.concept_id, "M0_YOY");
  assert.equal(result.entity_id, "CN");
  assert.equal(result.count, 3);
  assert.equal(Array.isArray(result.points), true);
  assert.deepEqual(Object.keys(result.points[0]).sort(), ["date", "source_used", "unit", "value"]);
  // The credential the caller resolved is the one the server saw.
  const auths = new Set(fake.state.calls.map((c) => c.authorization));
  assert.deepEqual([...auths], [`Bearer ${TOKEN}`]);
  assert.deepEqual(
    fake.state.calls.slice(0, 3).map((c) => c.method),
    ["initialize", "notifications/initialized", "tools/call"]
  );
});

test("read over a plain JSON body: the bare-array shape", async () => {
  fake.setFraming("json");
  try {
    const result = await source.callTool({
      server: "fd-open-data-mcp",
      tool: "read",
      args: { concept_id: "M0_YOY" },
      ownerEmail: null,
    });
    assert.equal(Array.isArray(result), true);
    assert.equal(result[0].from_cache, true);
  } finally {
    fake.setFraming("sse");
  }
});

test("a transport failure is retried exactly once", async () => {
  fake.failNextRequest();
  const result = await source.callTool({
    server: "fd-open-data-mcp",
    tool: "read_series",
    args: { concept_id: "M0_YOY" },
    ownerEmail: null,
  });
  assert.equal(result.count, 3);

  let attempts = 0;
  const countingFetch = (...args) => {
    attempts += 1;
    return fetch(...args);
  };
  fake.failAllRequests(true);
  try {
    await assert.rejects(
      source.callTool({
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: {},
        ownerEmail: null,
        fetchImpl: countingFetch,
      }),
      (err) => err instanceof source.ChartSourceError && err.code === "unreachable"
    );
  } finally {
    fake.failAllRequests(false);
  }
  // Two attempts, each with its own initialize — the retry is the whole
  // handshake, not a resumed session.
  assert.equal(attempts, 2);
});

test("a 401 is a credential failure, not a transport retry", async () => {
  const other = createFakeMcp({ token: "different-token" });
  const otherUrl = await other.listen();
  try {
    extensionStore.updateMcpServer("fd-open-data-mcp", { config: { url: otherUrl, credentialRef: "registry" } });
    let attempts = 0;
    await assert.rejects(
      source.callTool({
        server: "fd-open-data-mcp",
        tool: "read_series",
        args: {},
        ownerEmail: null,
        fetchImpl: (...args) => {
          attempts += 1;
          return fetch(...args);
        },
      }),
      (err) => err.code === "credential" && err.status === 401
    );
    // One call only: an answer (401) is never retried as a transport fault.
    assert.equal(attempts, 1);
  } finally {
    await other.close();
    extensionStore.updateMcpServer("fd-open-data-mcp", { config: { url, credentialRef: "registry" } });
  }
});

test("no live credential refuses before any request is made", async () => {
  registryCredentials.disconnect(null);
  const before = fake.state.calls.length;
  await assert.rejects(
    source.callTool({ server: "fd-open-data-mcp", tool: "read_series", args: {}, ownerEmail: null }),
    (err) => err.code === "credential"
  );
  assert.equal(fake.state.calls.length, before);
  registryCredentials.store({ email: null, token: TOKEN, source: "paste" });
});

test("an uninstalled server is unreachable, and a stdio config has no replayable endpoint", async () => {
  await assert.rejects(
    source.callTool({ server: "nope", tool: "read_series", args: {}, ownerEmail: null }),
    (err) => err.code === "unreachable"
  );
  extensionStore.addMcpServer({ name: "stdio-only", config: { command: "node", args: ["x.js"] } });
  await assert.rejects(
    source.callTool({ server: "stdio-only", tool: "read_series", args: {}, ownerEmail: null }),
    (err) => err.code === "unreachable" && /stdio/.test(err.message)
  );
});

// ── 1.3 the mapping contract ────────────────────────────────────────────────

test("the default map covers both probed shapes", () => {
  assert.deepEqual(source.defaultMapForTool("read_series"), {
    rows: "points[]",
    period: "date",
    value: "value",
    source: "source_used",
    series: null,
  });
  assert.equal(source.defaultMapForTool("read").rows, "@root");
  assert.equal(source.defaultMapForTool("policy_delete"), null);
});

test("monthly periods normalize to YYYY-MM from the period-start label", () => {
  assert.equal(source.normalizePeriod("2026-08-01", "monthly"), "2026-08");
  assert.equal(source.normalizePeriod("2026-08", "monthly"), "2026-08");
  assert.equal(source.normalizePeriod("2026-13-01", "monthly"), null);
  assert.equal(source.normalizePeriod("2026", "monthly"), null, "a bare year cannot be placed in a month");
});

test("yearly periods normalize to YYYY from either label form", () => {
  assert.equal(source.normalizePeriod("2019-12-31", "yearly"), "2019");
  assert.equal(source.normalizePeriod("2023", "yearly"), "2023");
  assert.equal(source.normalizePeriod("2023-12", "yearly"), "2023");
  assert.equal(source.normalizePeriod("2023Q4", "yearly"), null);
});

test("the monthly fake maps to three normalized points", () => {
  const result = {
    concept_id: "M0_YOY",
    points: [
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ],
  };
  const evaluated = source.evaluateMap(result, source.defaultMapForTool("read_series"), "monthly");
  assert.equal(evaluated.ok, true);
  assert.deepEqual(
    evaluated.points.map((p) => [p.period, p.value]),
    [
      ["2026-01", 7.1],
      ["2026-02", 6.6],
      ["2026-03", 6.9],
    ]
  );
  assert.deepEqual([...evaluated.units], ["%"]);
  assert.deepEqual(evaluated.anomalies, []);
});

test("the probed yearly duplicate collapses to one point under the normalized key", () => {
  const result = {
    points: [
      { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
      { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
      { date: "2023-12-31", value: 126.1, unit: "亿元", source_used: "stats" },
    ],
  };
  const evaluated = source.evaluateMap(result, source.defaultMapForTool("read_series"), "yearly");
  assert.equal(evaluated.ok, true);
  assert.deepEqual(
    evaluated.points.map((p) => [p.period, p.value]),
    [
      ["2022", 121.0],
      ["2023", 126.1],
    ]
  );
  assert.deepEqual(evaluated.anomalies, []);
});

test("same period, different values is an anomaly: neither written, both recorded", () => {
  const result = {
    points: [
      { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
      { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
      { date: "2023-12-31", value: 130.4, unit: "亿元", source_used: "stats" },
    ],
  };
  const evaluated = source.evaluateMap(result, source.defaultMapForTool("read_series"), "yearly");
  assert.equal(evaluated.ok, true);
  assert.deepEqual(evaluated.points.map((p) => p.period), ["2022"], "the conflicted period is not written");
  assert.equal(evaluated.anomalies.length, 1);
  assert.equal(evaluated.anomalies[0].period, "2023");
  assert.deepEqual(
    evaluated.anomalies[0].values.map((v) => v.value),
    [126.1, 130.4]
  );
});

test("a bare array maps through @root, and a dotted path resolves a nested row list", () => {
  const rows = [{ date: "2026-05-01", value: 1, unit: "u", source_used: "s" }];
  const root = source.evaluateMap(rows, source.defaultMapForTool("read"), "monthly");
  assert.equal(root.ok, true);
  assert.deepEqual(root.points.map((p) => p.period), ["2026-05"]);

  const nested = source.evaluateMap({ data: { rows } }, { rows: "data.rows[]", period: "date", value: "value", source: "source_used", series: null }, "monthly");
  assert.equal(nested.ok, true);
  assert.equal(nested.points.length, 1);
});

test("a declared map is validated: unknown fields, missing fields, bad paths", () => {
  assert.equal(source.validateMap({ rows: "points[]", period: "date", value: "value", source: "source_used" }).ok, true);
  assert.match(source.validateMap({ rows: "points[]", period: "d", value: "v", source: "s", filter: "x" }).reason, /unknown map field/);
  assert.match(source.validateMap({ rows: "points[]", period: "d", value: "v" }).reason, /map.source is required/);
  assert.equal(source.validateMap(null).ok, false);
});

test("a response that does not satisfy the contract is refused whole", () => {
  const map = source.defaultMapForTool("read_series");
  const missingRows = source.evaluateMap({ points: "nope" }, map, "monthly");
  assert.equal(missingRows.ok, false);
  assert.match(missingRows.reason, /no row list/);

  const badPeriod = source.evaluateMap(
    { points: [{ date: "not-a-date", value: 1, unit: "%", source_used: "s" }] },
    map,
    "monthly"
  );
  assert.match(badPeriod.reason, /does not parse as monthly/);

  const badValue = source.evaluateMap(
    { points: [{ date: "2026-01-01", value: "n/a", unit: "%", source_used: "s" }] },
    map,
    "monthly"
  );
  assert.match(badValue.reason, /value is not numeric/);

  const noField = source.evaluateMap({ points: [{ value: 1 }] }, map, "monthly");
  assert.match(noField.reason, /has no "date"/);

  // One bad row refuses the whole response — data is never partially absorbed.
  const oneBadRow = source.evaluateMap(
    {
      points: [
        { date: "2026-01-01", value: 1, unit: "%", source_used: "s" },
        { date: "合计", value: 2, unit: "%", source_used: "s" },
      ],
    },
    map,
    "monthly"
  );
  assert.equal(oneBadRow.ok, false);
});

test("a map.series field resolving to several series is refused (one map covers one series)", () => {
  const result = [
    { date: "2026-01-01", value: 1, unit: "%", source_used: "s", entity_id: "CN" },
    { date: "2026-01-01", value: 2, unit: "%", source_used: "s", entity_id: "US" },
  ];
  const map = { rows: "@root", period: "date", value: "value", source: "source_used", series: "entity_id" };
  const evaluated = source.evaluateMap(result, map, "monthly");
  assert.equal(evaluated.ok, false);
  assert.match(evaluated.reason, /one map covers one series/);
});

test("units are read from every mapped row and de-duplicated", () => {
  const result = {
    points: [
      { date: "2026-01-01", value: 1, unit: "%", source_used: "s" },
      { date: "2026-02-01", value: 2, unit: "%", source_used: "s" },
    ],
  };
  const evaluated = source.evaluateMap(result, source.defaultMapForTool("read_series"), "monthly");
  assert.deepEqual([...evaluated.units], ["%"]);
});

test("frequency can be read off the chart's own labels for the inference path", () => {
  assert.equal(source.inferFrequencyFromLabels(["2019", "2020", "2021"]), "yearly");
  assert.equal(source.inferFrequencyFromLabels(["2026-01", "2026-02"]), "monthly");
  assert.equal(source.inferFrequencyFromLabels(["2026-01-01", "2026-02-01"]), "monthly");
  assert.equal(source.inferFrequencyFromLabels(["Q1", "Q2"]), null);
  assert.equal(source.inferFrequencyFromLabels([]), null);
});

// ── the freshness gate ──────────────────────────────────────────────────────

test("the freshness fingerprint is stable when nothing moved and changes when it did", async () => {
  const first = await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: "M0_YOY", ownerEmail: null });
  const again = await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: "M0_YOY", ownerEmail: null });
  assert.equal(first, again);
  fake.setStats({ latest_date: "2026-04", last_fetch: "2026-05-01T00:00:00Z" });
  const moved = await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: "M0_YOY", ownerEmail: null });
  assert.notEqual(moved, first);
});

test("an unreadable gate yields null (the caller then reads) rather than failing the refresh", async () => {
  assert.equal(await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: null, ownerEmail: null }), null);
  fake.failAllRequests(true);
  try {
    assert.equal(await source.freshnessFingerprint({ server: "fd-open-data-mcp", concept: "M0_YOY", ownerEmail: null }), null);
  } finally {
    fake.failAllRequests(false);
  }
});