// The declared channel end to end: the loopback route that `chart_bind`
// posts to, and the auth boundary around it (openspec: add-chart-data-binding,
// task 3.3).
//
// The real dsh child needs a live model turn, so the child's half is covered by
// the plugin's own suite (test-chart-bind-bridge.mjs) and by the live probe;
// what is verified HERE is everything on the platform side of the loopback
// call: which chart a declaration lands on, what the binding records, and that
// a non-loopback caller never reaches the route.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "chart-declared-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");

const express = (await import("express")).default;
const db = await import("../db.js");
const resources = await import("../resources.js");
const chartRefresh = await import("../chart-refresh.js");
const { registerResourceRoutes } = await import("../server/routes/resources.js");
const { registerAuth } = await import("../server/auth.js");

await db.initDb();
assert.ok(db.isDbReady());

// A cell with the runtime's current session and a turn in flight.
const ctx = {
  dshSessionId: "runtime-session-1",
  dshTurnStartedAt: null,
  broadcast: () => {},
};
const events = [];
const app = express();
app.use(express.json());
await resources.initStore({ broadcast: (msg) => events.push(msg) });
ctx.app = app;
registerResourceRoutes(ctx);
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
              /* non-JSON */
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

const M0_ROWS = [
  { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
  { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
  { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
];
const M0_OPTION = {
  title: { text: "M0 同比" },
  xAxis: { type: "category", data: ["2026-01", "2026-02", "2026-03"] },
  series: [{ name: "M0", type: "line", data: [7.1, 6.6, 6.9] }],
};

let seq = 0;
// The call of the most recent turn. Each turn gets its OWN arguments: binding
// identity is the lineage of (server, tool, args, map), deliberately shared
// across charts, so two turns that named identical arguments would share one
// binding row — and each of these tests is about its own turn's chart.
let lastCallArgs = null;
// A turn: the tool call runs, then the chart is captured — the order the real
// runtime produces (the chart fence lands before the declaration can).
function runTurn({ option = M0_OPTION, withCall = true, sessionId = "runtime-session-1" } = {}) {
  seq += 1;
  const row = { ...option, title: { text: `${option.title.text} #${seq}` } };
  ctx.dshTurnStartedAt = new Date().toISOString();
  lastCallArgs = { concept_id: "M0_YOY", entity_type: "country", entity_id: "CN", turn: `turn-${seq}` };
  const blocks = withCall
    ? [
        {
          kind: "tool",
          id: `call-${seq}`,
          name: "mcp__fd-open-data-mcp__read_series",
          args: lastCallArgs,
          result: JSON.stringify({ concept_id: "M0_YOY", points: M0_ROWS }),
          state: "done",
        },
      ]
    : null;
  const created = resources.captureFromMessage({
    sessionId,
    messageId: seq,
    sessionTitle: "声明测试",
    text: `\`\`\`echarts\n${JSON.stringify(row)}\n\`\`\``,
    blocks,
  });
  return created[0] ?? db.findResourceByHash(hash(row));
}

import { createHash } from "node:crypto";
function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ── the route ───────────────────────────────────────────────────────────────

test("a declaration lands on this turn's chart, at origin declared", async () => {
  const chart = runTurn();
  events.length = 0;
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
    note: "M0 同比趋势",
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.binding.origin, "declared");
  assert.equal(res.json.binding.server, "fd-open-data-mcp");
  assert.equal(res.json.binding.tool, "read_series");
  assert.equal(res.json.binding.frequency, "monthly");
  assert.equal(res.json.binding.unit, "%", "the declaring turn's own result seeds the unit");
  assert.equal(res.json.binding.refreshable, true);
  assert.deepEqual(res.json.binding.args, lastCallArgs);
  assert.equal(res.json.note, "M0 同比趋势");

  const stored = resources.get(chart.id);
  assert.equal(stored.bindings.length, 1);
  assert.equal(stored.bindings[0].origin, "declared");
  // The declaration never fetches: nothing is stored until a refresh runs.
  assert.equal(db.listSeriesPoints(res.json.binding.id).length, 0);
  assert.deepEqual(
    events.filter((e) => e.type === "resources_changed").map((e) => e.action),
    ["bound"]
  );
});

test("a declared binding outranks an inference on the same series", async () => {
  // The chart witnesses its call, so capture infers a binding first...
  const chart = runTurn();
  const inferred = resources.get(chart.id).bindings[0];
  assert.equal(inferred.origin, "inferred");
  // ...and the agent's declaration then takes over the series.
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  assert.equal(res.status, 200, res.text);
  const bindings = resources.get(chart.id).bindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].origin, "declared");
  assert.equal(bindings[0].id, inferred.id, "the same identity row, promoted");
});

test("a declaration with no chart in the turn is refused with a reason the model can relay", async () => {
  ctx.dshTurnStartedAt = new Date().toISOString();
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "no_chart_in_turn");
  assert.match(res.json.error, /echarts/);
});

test("a declaration cannot reach a chart from an earlier turn", async () => {
  runTurn();
  // The next turn starts with its own window: the previous chart is out of
  // scope, exactly as the in-flight rule requires.
  ctx.dshTurnStartedAt = new Date(Date.now() + 1000).toISOString();
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "no_chart_in_turn");
});

test("a declaration cannot reach another session's chart", async () => {
  runTurn({ sessionId: "some-other-session" });
  ctx.dshTurnStartedAt = new Date().toISOString();
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, "no_chart_in_turn");
});

test("a declaration of a non-bindable tool or server is refused with the reason", async () => {
  runTurn();
  const notMcp = await call("POST", "/api/resources/bind-declared", { tool: "read_series", args: {} });
  assert.equal(notMcp.status, 400);
  assert.match(notMcp.json.error, /MCP 工具名/);

  const writeTool = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__policy_delete",
    args: {},
  });
  assert.equal(writeTool.status, 400);
  assert.match(writeTool.json.error, /时序读取工具/);

  const otherServer = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-daas-mcp__read_series",
    args: {},
  });
  assert.equal(otherServer.status, 400);
  assert.match(otherServer.json.error, /不在可绑定的数据源列表/);
});

test("a declaration whose chart has no readable cadence is refused, not guessed", async () => {
  const quarterly = {
    title: { text: "季度图" },
    xAxis: { type: "category", data: ["2026Q1", "2026Q2"] },
    series: [{ name: "x", type: "bar", data: [1, 2] }],
  };
  runTurn({ option: quarterly, withCall: false });
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /周期标签/);
});

// ── the auth boundary ───────────────────────────────────────────────────────

function authGate({ authMode = undefined, authEnabled = true } = {}) {
  const middlewares = [];
  const ctx = {
    app: { use: (fn) => middlewares.push(fn) },
    authMode,
    authEnabled,
    CLOUD_MODE: false,
  };
  registerAuth(ctx);
  const gate = middlewares[0];
  return async (req) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ rejected: true, status: this.statusCode, body });
          return this;
        },
        redirect() {
          resolve({ rejected: true, status: 302 });
          return this;
        },
        accepts: () => false,
      };
      gate(req, res, () => resolve({ rejected: false, user: req.user }));
    });
}

test("the declared route is reachable from loopback and nowhere else", async () => {
  const gate = authGate();
  const loopback = await gate({
    path: "/api/resources/bind-declared",
    method: "POST",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.equal(loopback.rejected, false, "the cell's own child may declare");
  assert.equal(loopback.user.internal, true);
  assert.equal(loopback.user.email, "chart-bridge@internal");

  const external = await gate({
    path: "/api/resources/bind-declared",
    method: "POST",
    headers: {},
    socket: { remoteAddress: "10.42.0.9" },
  });
  assert.equal(external.rejected, true, "a remote caller faces the full gate");
  assert.equal(external.status, 401);

  // The exemption is that ONE path: the binding mutations around it stay behind
  // the gate for every caller, loopback included.
  for (const route of [
    "/api/resources/abc/bindings",
    "/api/resources/abc/bindings/b1/refresh",
    "/api/resources/abc/observations",
  ]) {
    const res = await gate({
      path: route,
      method: "POST",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    assert.equal(res.rejected, true, `${route} must not be exempted`);
  }
});

test("the declared route is exempt in logto mode too (a hosted cell)", async () => {
  const gate = authGate({ authMode: "logto" });
  const loopback = await gate({
    path: "/api/resources/bind-declared",
    method: "POST",
    headers: {},
    socket: { remoteAddress: "::1" },
  });
  assert.equal(loopback.rejected, false);
  assert.equal(loopback.user.internal, true);
  const external = await gate({
    path: "/api/resources/bind-declared",
    method: "POST",
    headers: {},
    socket: { remoteAddress: "10.42.0.9" },
  });
  assert.equal(external.rejected, true);
});

test("chart refresh is wired into the library's lifecycle (a declared binding is schedulable)", async () => {
  // initChartRefresh is what server.js calls at boot; the declared channel's
  // route only writes a binding, so this asserts the two halves meet: a
  // declared binding with a cron rule gets a timer and appears to the sweeper.
  const chart = runTurn();
  const res = await call("POST", "/api/resources/bind-declared", {
    tool: "mcp__fd-open-data-mcp__read_series",
    args: { ...lastCallArgs },
  });
  const bindingId = res.json.binding.id;
  const rule = await call("PATCH", `/api/resources/${chart.id}/bindings/${bindingId}/refresh-rule`, {
    refreshRule: { cron: "0 9 1 * *", tz: "Asia/Shanghai" },
  });
  assert.equal(rule.status, 200, rule.text);
  assert.equal(rule.json.binding.refreshRule.cron, "0 9 1 * *");

  const scheduled = chartRefresh.initChartRefresh({ broadcast: ctx.broadcast, ownerEmail: null });
  assert.ok(scheduled.scheduled >= 1, "the declared+rule binding is on the scheduler");
  chartRefresh.shutdownChartRefresh();
});