// ── Fake fd-open-data-mcp (chart data binding tests/e2e) ─────────────────────
//
// A streamable-http MCP server that answers exactly the shapes the live
// upstream was probed to return (see the change's design.md), so the refresh
// loop can be driven end to end without the tailnet:
//
//   read_series  → {concept_id, entity_type, entity_id, start, end, count,
//                   points: [{date, value, unit, source_used}]}
//   read         → bare array of {date, value, unit, source_used, from_cache}
//   data_stats   → {concepts: [{concept_id, rows, latest_date, last_fetch}]}
//
// Scenarios are settable at runtime (append a point, revise a value, switch the
// source, return a 500, frame the body as JSON instead of SSE) so one process
// can play out a whole scripted sequence of refreshes.
//
// Two entry points, one implementation: `createFakeMcp()` for in-process tests,
// and the CLI mode (`node e2e/fake-mcp.js`) for the e2e harness, which needs a
// real HTTP port the platform cell can reach.

import { createServer } from "node:http";

// The probed shapes: monthly labels period-start, yearly labels period-end.
const SCENARIOS = {
  monthly: {
    concept: "M0_YOY",
    frequency: "monthly",
    unit: "%",
    points: [
      { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
      { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
      { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
    ],
  },
  // The probed yearly defect: one response carries both `2023` and
  // `2023-12-31` for the same period.
  yearlyDuplicate: {
    concept: "GDP_NOMINAL",
    frequency: "yearly",
    unit: "亿元",
    points: [
      { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
      { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
      { date: "2023-12-31", value: 126.1, unit: "亿元", source_used: "stats" },
    ],
  },
  // ...and its collision form: same period, two different values.
  yearlyCollision: {
    concept: "GDP_NOMINAL",
    frequency: "yearly",
    unit: "亿元",
    points: [
      { date: "2022", value: 121.0, unit: "亿元", source_used: "stats" },
      { date: "2023", value: 126.1, unit: "亿元", source_used: "stats" },
      { date: "2023-12-31", value: 130.4, unit: "亿元", source_used: "stats" },
    ],
  },
};

export function createFakeMcp({ port = 0, scenario = "monthly", framing = "sse", token = null } = {}) {
  const state = {
    scenario,
    framing,
    token,
    points: [...(SCENARIOS[scenario]?.points ?? [])],
    concept: SCENARIOS[scenario]?.concept ?? "M0_YOY",
    frequency: SCENARIOS[scenario]?.frequency ?? "monthly",
    unit: SCENARIOS[scenario]?.unit ?? "%",
    stats: { rows: 3, latest_date: "2026-03", last_fetch: "2026-04-01T00:00:00Z" },
    failNext: false,
    failAll: false,
    calls: [],
    sessions: new Set(),
  };

  const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  function toolCall(name, args) {
    if (name === "data_stats") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ concepts: [{ concept_id: state.concept, ...state.stats }] }),
          },
        ],
      };
    }
    if (name === "read_series") {
      if (args?.concept_id && args.concept_id !== state.concept) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: unknown concept ${args.concept_id}` }],
        };
      }
      const points = state.points;
      const payload = {
        concept_id: state.concept,
        entity_type: "country",
        entity_id: "CN",
        start: points[0]?.date ?? null,
        end: points[points.length - 1]?.date ?? null,
        count: points.length,
        points,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    if (name === "read") {
      const payload = state.points.map((p) => ({ ...p, from_cache: true }));
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    return rpcError(null, -32601, `unknown tool ${name}`);
  }

  const server = createServer((req, res) => {
    // Control channel for the e2e harness: a spec drives the scenario (append a
    // point, fail the next call) over HTTP, because the fake runs in the
    // webServer process, not in the test process.
    if (req.url === "/__control" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          /* keep the empty body */
        }
        if (body.scenario) {
          state.scenario = body.scenario;
          const preset = SCENARIOS[body.scenario];
          if (preset) {
            state.concept = preset.concept;
            state.frequency = preset.frequency;
            state.unit = preset.unit;
            state.points = preset.points.map((p) => ({ ...p }));
          }
        }
        if (Array.isArray(body.points)) state.points = body.points.map((p) => ({ ...p }));
        if (body.stats) state.stats = { ...state.stats, ...body.stats };
        if (typeof body.failAll === "boolean") state.failAll = body.failAll;
        if (typeof body.framing === "string") state.framing = body.framing;
        if (body.resetCalls) state.calls.length = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, points: state.points.length, failAll: state.failAll }));
      });
      return;
    }
    if (req.url === "/__control" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ scenario: state.scenario, points: state.points, failAll: state.failAll, calls: state.calls.length }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      let message = null;
      try {
        message = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      state.calls.push({ method: message.method, params: message.params, authorization: req.headers.authorization ?? null });

      if (state.token && req.headers.authorization !== `Bearer ${state.token}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (state.failAll || state.failNext) {
        if (state.failNext) state.failNext = false;
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "upstream exploded" }));
        return;
      }

      // A notification has no id and expects no body.
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      let payload = null;
      const headers = { "content-type": "application/json" };
      if (message.method === "initialize") {
        const sessionId = `fake-${state.sessions.size + 1}`;
        state.sessions.add(sessionId);
        headers["mcp-session-id"] = sessionId;
        payload = rpcResult(message.id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "fd-open-data-mcp-fake", version: "4.0.5" },
          capabilities: { tools: {} },
        });
      } else if (message.method === "tools/list") {
        payload = rpcResult(message.id, {
          tools: [
            { name: "read_series", description: "cache-only series read", inputSchema: { type: "object" } },
            { name: "read", description: "read-through series read", inputSchema: { type: "object" } },
            { name: "data_stats", description: "coverage statistics", inputSchema: { type: "object" } },
          ],
        });
      } else if (message.method === "tools/call") {
        payload = rpcResult(message.id, toolCall(message.params?.name, message.params?.arguments));
      } else {
        payload = rpcError(message.id, -32601, `unknown method ${message.method}`);
      }

      if (state.framing === "sse") {
        headers["content-type"] = "text/event-stream";
        res.writeHead(200, headers).end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.writeHead(200, headers).end(JSON.stringify(payload));
      }
    });
  });

  return {
    server,
    state,
    // Start listening; resolves with the base URL.
    async listen() {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      const { port: actual } = server.address();
      this.url = `http://127.0.0.1:${actual}/mcp`;
      return this.url;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
    // ── scenario control ──
    setPoints(points) {
      state.points = points.map((p) => ({ ...p }));
    },
    appendPoint(point) {
      state.points.push({ ...point });
    },
    setStats(stats) {
      state.stats = { ...state.stats, ...stats };
    },
    setUnit(unit) {
      state.unit = unit;
      state.points = state.points.map((p) => ({ ...p, unit }));
    },
    setConcept(concept, { frequency = null, unit = null } = {}) {
      state.concept = concept;
      if (frequency) state.frequency = frequency;
      if (unit) state.unit = unit;
    },
    setSource(source) {
      state.points = state.points.map((p) => ({ ...p, source_used: source }));
    },
    setFraming(framing) {
      state.framing = framing;
    },
    failNextRequest() {
      state.failNext = true;
    },
    failAllRequests(fail = true) {
      state.failAll = fail;
    },
    calls() {
      return state.calls;
    },
    toolCalls() {
      return state.calls.filter((c) => c.method === "tools/call").map((c) => c.params?.name);
    },
    resetCalls() {
      state.calls.length = 0;
    },
  };
}

export const FAKE_SCENARIOS = SCENARIOS;

if (process.argv[1] && process.argv[1].endsWith("fake-mcp.js")) {
  const fake = createFakeMcp({
    port: Number(process.env.FAKE_MCP_PORT || 0),
    scenario: process.env.FAKE_MCP_SCENARIO || "monthly",
    framing: process.env.FAKE_MCP_FRAMING || "sse",
    token: process.env.FAKE_MCP_TOKEN || null,
  });
  const url = await fake.listen();
  process.stdout.write(`${url}\n`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}