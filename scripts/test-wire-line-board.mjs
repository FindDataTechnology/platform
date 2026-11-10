// Unit tests — wire line board server side (add-wire-line-board, tasks 1-3, 5.1).
// Run: node --test scripts/test-wire-line-board.mjs
//
//   1.x  executor: real HTTP MCP server (sdk) — bearer passthrough, tool/args,
//        success summary, upstream 422 field passthrough, upstream 401 →
//        markInvalid, timeout, unroutable tool, missing credential.
//   2.x  identity chain: auth middleware exempts ONLY loopback POST
//        /api/actions/propose; propose records the child-named proposer.
//   2.x  profile injection: writeMcpPatch stamps ACTIONS_MCP_PROPOSER_EMAIL on
//        the stdio `actions` child from the owner email (lowercased), and
//        stamps nothing when there is no owner email.
//   3.x  gate routes: propose strips model compliance values + returns the
//        schema; preflight refuses without the wire credential; approve
//        validates userArgs (missing required / unexpected key / merge),
//        executes via the ctx seam, writes audit (no secrets), broadcasts
//        board_changed; 422 → fields; 401 → credential cleared + stale event.
//   5.x  WireBoardAdapter: connected renders four real blocks; any 401 clears
//        the credential and returns unconnected; no token → zero upstream
//        calls; single-block failure degrades alone.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wire-board-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const lc = await import("../line-credentials.js");
const registry = await import("../lib/action-registry.js");
const { executeRegisteredAction, ExecutorError, classifyToolResult, parseFieldErrors } = await import("../lib/action-executor.js");
const actions = await import("../server/routes/actions.js");
const { registerAuth } = await import("../server/auth.js");
const { WireBoardAdapter, WIRE_LINE_CREDENTIAL } = await import("../lib/board-adapters.js");
const { writeMcpPatch } = await import("../dsh-profile.js");

const EMAIL = "wire-owner@test.example";
const OTHER = "someone-else@test.example";

const idToken = (secs = 3600) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: "w1", email: EMAIL, exp: Math.floor(Date.now() / 1000) + secs })).toString("base64url");
  return `${h}.${p}.sig`;
};

const mockRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

// ── 1. executor against a real Streamable HTTP MCP server ───────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function startFakeWireMcp({ onCall } = {}) {
  const seen = { auth: [], calls: [] };
  let pendingHang = null;
  const server = http.createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization ?? null);
    let body = "";
    for await (const chunk of req) body += chunk;
    const mcp = new Server({ name: "fake-wire", version: "0.1.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "wire_demand_submit", description: "x", inputSchema: { type: "object" } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen.calls.push(request.params);
      if (onCall) return onCall(request.params, req);
      return { content: [{ type: "text", text: "demand D-0100 created" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    async stop() {
      if (pendingHang) pendingHang();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const action = (id) => registry.getAction(id);

test("1.1 executor sends the bearer verbatim and returns the tool text", async () => {
  const fake = await startFakeWireMcp();
  try {
    const result = await executeRegisteredAction({
      action: action("wire.demand.submit"),
      args: { title: "竞品价格", source_urls: ["https://example.test/a"], public_data_asserted: true },
      email: EMAIL,
      deps: { resolveEndpoint: () => fake.url, liveToken: () => "tok-live" },
    });
    assert.match(result.summary, /D-0100/);
    assert.equal(result.server, "wire-ops-mcp");
    assert.ok(fake.seen.auth.length >= 2, "initialize + tools/call both hit the server");
    assert.ok(fake.seen.auth.every((a) => a === "Bearer tok-live"), "every request carries the user bearer");
    const call = fake.seen.calls.at(-1);
    assert.equal(call.name, "wire_demand_submit");
    assert.equal(call.arguments.title, "竞品价格");
    assert.deepEqual(Object.keys(call.arguments).sort(), ["public_data_asserted", "source_urls", "title"]);
  } finally {
    await fake.stop();
  }
});

test("1.1 executor: liveToken seam supplies the bearer", async () => {
  const fake = await startFakeWireMcp();
  try {
    await executeRegisteredAction({
      action: action("wire.market.subscribe"),
      args: { dataset_id: "ds_9" },
      email: EMAIL,
      deps: {
        resolveEndpoint: () => fake.url,
        liveToken: () => "tok-live",
      },
    });
    assert.ok(fake.seen.calls.at(-1).name === "wire_market_subscribe");
  } finally {
    await fake.stop();
  }
});

test("1.2 upstream 401 → upstream_401, markInvalid(email, wire-customer), credential flagged", async () => {
  const fake = await startFakeWireMcp({
    onCall: () => ({ content: [{ type: "text", text: "[unauthorized] token expired (HTTP 401)" }], isError: true }),
  });
  const invalidated = [];
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wire.market.subscribe"),
        args: { dataset_id: "ds_9" },
        email: EMAIL,
        deps: { resolveEndpoint: () => fake.url, liveToken: () => "tok-live", markInvalid: (e, r) => invalidated.push([e, r]) },
      }),
      (err) => {
        assert.ok(err instanceof ExecutorError);
        assert.equal(err.code, "upstream_401");
        assert.equal(err.credentialInvalidated, true);
        assert.equal(err.ref, WIRE_LINE_CREDENTIAL);
        return true;
      },
    );
    assert.deepEqual(invalidated, [[EMAIL, "wire-customer"]]);
  } finally {
    await fake.stop();
  }
});

test("1.2 upstream 422 → upstream_422 with the detail verbatim and parsed fields", async () => {
  const detail = '[{"loc":["body","source_urls",0],"msg":"invalid or non-public URL","type":"value_error"}]';
  const fake = await startFakeWireMcp({
    onCall: () => ({ content: [{ type: "text", text: `[invalid] ${detail} (HTTP 422)` }], isError: true }),
  });
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wire.demand.submit"),
        args: { title: "x" },
        email: EMAIL,
        deps: { resolveEndpoint: () => fake.url, liveToken: () => "tok-live", markInvalid: () => {} },
      }),
      (err) => {
        assert.equal(err.code, "upstream_422");
        assert.equal(err.message, detail, "detail passed through verbatim");
        assert.deepEqual(err.fields, [{ field: "source_urls.0", message: "invalid or non-public URL", type: "value_error" }]);
        return true;
      },
    );
  } finally {
    await fake.stop();
  }
});

test("1.2 unroutable tool and missing credential fail honestly", async () => {
  await assert.rejects(
    executeRegisteredAction({
      action: { ...action("facet.pack.visibility"), credentialRef: undefined },
      args: {},
      email: EMAIL,
      deps: { resolveEndpoint: () => "http://127.0.0.1:1/mcp" },
    }),
    (err) => err.code === "credential_ref_unknown",
  );
  await assert.rejects(
    executeRegisteredAction({
      action: { ...action("wire.demand.submit"), tool: "facet_market_pack_visibility" },
      args: {},
      email: EMAIL,
      deps: { resolveEndpoint: () => "http://127.0.0.1:1/mcp", liveToken: () => "tok" },
    }),
    (err) => err.code === "tool_unroutable",
  );
  await assert.rejects(
    executeRegisteredAction({
      action: action("wire.demand.submit"),
      args: {},
      email: EMAIL,
      deps: { resolveEndpoint: () => "http://127.0.0.1:1/mcp", liveToken: () => null },
    }),
    (err) => err.code === "credential_missing",
  );
  await assert.rejects(
    executeRegisteredAction({
      action: action("wire.demand.submit"),
      args: {},
      email: EMAIL,
      deps: { resolveEndpoint: () => null, liveToken: () => "tok" },
    }),
    (err) => err.code === "endpoint_unresolved",
  );
});

test("1.2 timeout surfaces as transport_error, never as success", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = await startFakeWireMcp({ onCall: async () => { await gate; return { content: [] }; } });
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wire.demand.submit"),
        args: {},
        email: EMAIL,
        deps: { resolveEndpoint: () => fake.url, liveToken: () => "tok", timeoutMs: 300 },
      }),
      (err) => err.code === "transport_error",
    );
  } finally {
    release();
    await fake.stop();
  }
});

test("1.2 classify/parse unit: kinds, statuses, field-list recovery from Python repr", () => {
  const ok = classifyToolResult({ content: [{ type: "text", text: "done" }] });
  assert.equal(ok.ok, true);
  const v = classifyToolResult({ content: [{ type: "text", text: "[forbidden] viewer is read-only (HTTP 403)" }], isError: true });
  assert.equal(v.status, 403);
  assert.equal(v.kind, "forbidden");
  const py = parseFieldErrors("[{'loc': ('body', 'title'), 'msg': 'Field required', 'type': 'missing'}]");
  assert.deepEqual(py, [{ field: "title", message: "Field required", type: "missing" }]);
  assert.deepEqual(parseFieldErrors("plain text"), []);
});

// ── 2. auth exemption is exactly loopback POST /api/actions/propose ─────────

function captureAuthMiddleware(ctxOverrides = {}) {
  const stack = [];
  const ctx = { app: { use: (fn) => stack.push(fn) }, authEnabled: true, authMode: "forward_auth", headerTrust: null, db: null, CLOUD_MODE: false, ...ctxOverrides };
  registerAuth(ctx);
  return { gate: stack[0] };
}

const fakeReq = (method, reqPath, remote = "127.0.0.1") => ({
  method,
  path: reqPath,
  url: reqPath,
  headers: {},
  socket: { remoteAddress: remote },
});

test("2.2 loopback propose is the internal bridge; approve/reject/query and remote propose are not", () => {
  const { gate } = captureAuthMiddleware();
  const cases = [
    { req: fakeReq("POST", "/api/actions/propose", "127.0.0.1"), expectInternal: true },
    { req: fakeReq("POST", "/api/actions/propose", "::1"), expectInternal: true },
    { req: fakeReq("POST", "/api/actions/propose", "10.0.0.9"), expectInternal: false },
    { req: fakeReq("POST", "/api/actions/abc/approve"), expectInternal: false },
    { req: fakeReq("POST", "/api/actions/abc/reject"), expectInternal: false },
    { req: fakeReq("GET", "/api/actions/abc"), expectInternal: false },
  ];
  for (const { req, expectInternal } of cases) {
    let nexted = false;
    const res = mockRes();
    gate(req, res, () => { nexted = true; });
    if (expectInternal) {
      assert.ok(nexted, `${req.method} ${req.path} should pass`);
      assert.equal(req.user.internal, true, `${req.method} ${req.path} should be internal`);
    } else {
      assert.equal(res.statusCode, 401, `${req.method} ${req.path} anonymous should be 401`);
      assert.equal(req.user, undefined);
    }
  }
});

// ── 2. profile injection ─────────────────────────────────────────────────────

test("2.1 writeMcpPatch stamps ACTIONS_MCP_PROPOSER_EMAIL (lowercased) on the stdio actions child only with an owner", async () => {
  fs.writeFileSync(
    process.env.MCP_CONFIG_PATH,
    JSON.stringify({ mcpServers: { actions: { command: "node", args: ["server/actions-mcp.js"] }, library: { command: "node", args: ["server/library-mcp.js"] } } }),
  );
  const patchPath = path.join(process.env.DSH_HOME, "profiles", process.env.DSH_PROFILE || "platform", "mcp.patch.yml");

  fs.rmSync(patchPath, { force: true });
  await writeMcpPatch({ ownerEmail: "Alice@X.Test" });
  let text = fs.readFileSync(patchPath, "utf8");
  assert.match(text, /ACTIONS_MCP_PROPOSER_EMAIL:?\s*"?"?alice@x\.test/);

  fs.rmSync(patchPath, { force: true });
  await writeMcpPatch({ ownerEmail: null });
  text = fs.readFileSync(patchPath, "utf8");
  assert.doesNotMatch(text, /ACTIONS_MCP_PROPOSER_EMAIL/);
});

// ── 3. gate routes end-to-end (executor stubbed via the ctx seam) ───────────

const proposeReq = (body, { internal = true, email = EMAIL } = {}) => ({
  body,
  ...(internal ? { user: { email: "actions-bridge@internal", internal: true } } : { user: email ? { email } : undefined }),
  ctx: { authEnabled: true },
});
const connected = () => {
  lc.store({ email: EMAIL, line: "wire-customer", token: idToken() });
};

test("3.1 propose strips model compliance values and returns the user-fill schema", async () => {
  connected();
  const res = mockRes();
  await actions.proposeAction(
    proposeReq({
      actionId: "wire.demand.submit",
      args: {
        title: "竞品价格月报",
        description: "希望增加竞品价格月报指标",
        contact_email: EMAIL,
        source_urls: ["https://model-invented.test/never-trust"],
        public_data_asserted: true,
      },
      proposerEmail: EMAIL,
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.state, "pending");
  assert.equal(res.body.tier, "inline");
  assert.deepEqual(
    res.body.userFilledArgs.map((f) => f.key),
    ["source_urls", "public_data_asserted"],
  );
  const row = db.getDb().prepare("SELECT args_json FROM action_proposals WHERE proposal_id = ?").get(res.body.proposalId);
  const stored = JSON.parse(row.args_json);
  assert.equal(stored.description, "希望增加竞品价格月报指标");
  assert.equal("title" in stored, false, "unknown tool arg must be dropped (wire_demand_submit has no title)");
  assert.equal("source_urls" in stored, false, "model compliance value must be discarded");
  assert.equal("public_data_asserted" in stored, false);
});

test("3.1 propose normalizes camelCase tool args (artifactId → artifact_id)", async () => {
  connected();
  const res = mockRes();
  await actions.proposeAction(
    proposeReq({ actionId: "wire.artifact.publish", args: { artifactId: 23 }, proposerEmail: EMAIL }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const row = db.getDb().prepare("SELECT args_json FROM action_proposals WHERE proposal_id = ?").get(res.body.proposalId);
  assert.deepEqual(JSON.parse(row.args_json), { artifact_id: 23 });
});

test("3.1 propose refuses a proposal missing a required tool arg before it is stored", async () => {
  connected();
  const count = () => db.getDb().prepare("SELECT COUNT(*) AS n FROM action_proposals").get().n;
  const before = count();
  const res = mockRes();
  await actions.proposeAction(
    proposeReq({ actionId: "wire.demand.submit", args: { title: "只有模型发明的键" }, proposerEmail: EMAIL }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid args");
  assert.deepEqual(res.body.missing, ["description", "contact_email"]);
  assert.deepEqual(res.body.expected, ["description", "contact_email", "company", "indicator_code"]);
  assert.match(res.body.details, /description, contact_email/, "the model is told which keys to send");
  assert.equal(count(), before, "no pending row for a proposal that could never execute");

  // A blank required value is a missing one.
  const blank = mockRes();
  await actions.proposeAction(
    proposeReq({ actionId: "wire.artifact.archive", args: { artifact_id: "  " }, proposerEmail: EMAIL }),
    blank,
  );
  assert.equal(blank.statusCode, 400);
  assert.deepEqual(blank.body.missing, ["artifact_id"]);
  assert.equal(count(), before);
});

// Also the ordering guard: {title} alone is an invalid-args body, yet without
// the credential the answer must still be the connect card, not a key list.
test("3.1 propose refuses without the wire credential and points at the connect card", async () => {
  lc.disconnect(EMAIL, "wire-customer");
  const res = mockRes();
  await actions.proposeAction(proposeReq({ actionId: "wire.demand.submit", args: { title: "x" }, proposerEmail: EMAIL }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "preflight failed");
  assert.equal(res.body.connectPath, "/settings/connections?panel=line-wire-customer");
  assert.equal(res.body.credentialRef, "wire-customer");
});

test("3.1 propose rejects an unregistered wire action outright", async () => {
  connected();
  const res = mockRes();
  await actions.proposeAction(proposeReq({ actionId: "wire.dataset.delete", args: {} }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "action not registered");
});

test("3.2 approve validates userArgs before anything executes", async () => {
  connected();
  const p = mockRes();
  await actions.proposeAction(
    proposeReq({ actionId: "wire.demand.submit", args: { description: "t", contact_email: EMAIL }, proposerEmail: EMAIL }),
    p,
  );
  const id = p.body.proposalId;

  const missing = mockRes();
  await actions.approveAction(
    { params: { id }, body: { userArgs: { source_urls: ["https://a.test"] } } , user: { email: EMAIL }, ctx: { authEnabled: true } },
    missing,
  );
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.details, /public_data_asserted/);

  const extra = mockRes();
  await actions.approveAction(
    { params: { id }, body: { userArgs: { source_urls: ["https://a.test"], public_data_asserted: true, title: "injected" } }, user: { email: EMAIL }, ctx: { authEnabled: true } },
    extra,
  );
  assert.equal(extra.statusCode, 400);
  assert.match(extra.body.details, /unexpected user arg: title/);

  const row = db.getDb().prepare("SELECT state FROM action_proposals WHERE proposal_id = ?").get(id);
  assert.equal(row.state, "pending", "validation failures leave the proposal pending");
});

test("3.2 approve is owner-only (another user gets 403; auth-off is the machine owner)", async () => {
  connected();
  const p = mockRes();
  await actions.proposeAction(
    proposeReq({ actionId: "wire.demand.submit", args: { description: "t", contact_email: EMAIL }, proposerEmail: EMAIL }),
    p,
  );
  const id = p.body.proposalId;
  const res = mockRes();
  await actions.approveAction(
    { params: { id }, body: {}, user: { email: OTHER }, ctx: { authEnabled: true } },
    res,
  );
  assert.equal(res.statusCode, 403);
});

// Executor stub for the route tests: the endpoint and the tool call are faked,
// but liveToken stays REAL so the bearer the gate hands over is the user's
// stored ID token from the DB — that is the property worth asserting.
function executorStub(toolResult) {
  return {
    resolveEndpoint: () => "http://127.0.0.1:9/mcp",
    markInvalid: () => {},
    callTool: async ({ toolName, args, bearer }) => toolResult({ toolName, args, bearer }),
  };
}

async function proposeDemand() {
  const p = mockRes();
  await actions.proposeAction(proposeReq({ actionId: "wire.demand.submit", args: { description: "竞品价格", contact_email: EMAIL, title: "竞品价格" }, proposerEmail: EMAIL }), p);
  assert.equal(p.statusCode, 200);
  return p.body.proposalId;
}

test("3.2/1.3 approve merges user values, executes, audits (no secrets) and broadcasts board_changed", async () => {
  connected();
  const id = await proposeDemand();
  const events = [];
  let seen;
  const ctx = {
    authEnabled: true,
    broadcast: (ev) => events.push(ev),
    actionExecutorDeps: executorStub(({ toolName, args, bearer }) => {
      seen = { toolName, args, bearer };
      return { content: [{ type: "text", text: "demand D-0100 created" }] };
    }),
  };
  const res = mockRes();
  await actions.approveAction(
    {
      params: { id },
      body: { userArgs: { source_urls: ["https://public.test/a"], public_data_asserted: true } },
      user: { email: EMAIL },
      ctx,
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.state, "executed");
  assert.match(res.body.resultSummary, /D-0100/);

  assert.equal(seen.toolName, "wire_demand_submit");
  assert.equal(seen.bearer.startsWith("eyJ"), true, "the user's live ID token is the bearer");
  assert.deepEqual(seen.args.source_urls, ["https://public.test/a"]);
  assert.equal(seen.args.public_data_asserted, true);
  assert.equal(seen.args.description, "竞品价格");
  assert.equal(seen.args.title, undefined, "unknown tool arg never reaches the MCP call");

  const audit = db.getDb().prepare("SELECT * FROM action_audit WHERE proposal_id = ?").get(id);
  assert.ok(audit, "audit row exists");
  assert.equal(audit.line, "wire");
  assert.equal(audit.error_text, null);
  assert.equal(audit.args_json, null, "ledger carries the digest only, never the args");
  assert.ok(!JSON.stringify(audit).includes("Bearer"), "no bearer in audit");
  const info = JSON.parse(audit.executor_info);
  assert.equal(info.proposer, EMAIL);
  assert.equal(info.server, "wire-ops-mcp");
  assert.equal(info.code, "ok");

  assert.ok(events.some((e) => e.type === "board_changed" && e.line === "wire" && e.resources.includes("demand")));
});

test("3.2 approve surfaces upstream 422 fields verbatim and marks the proposal failed (not rejected)", async () => {
  connected();
  const id = await proposeDemand();
  const detail = '[{"loc":["body","source_urls",0],"msg":"non-public URL","type":"value_error"}]';
  const ctx = {
    authEnabled: true,
    broadcast: () => {},
    actionExecutorDeps: executorStub(() => ({
      content: [{ type: "text", text: `[invalid] ${detail} (HTTP 422)` }],
      isError: true,
    })),
  };
  const res = mockRes();
  await actions.approveAction(
    {
      params: { id },
      body: { userArgs: { source_urls: ["https://x.test"], public_data_asserted: true } },
      user: { email: EMAIL },
      ctx,
    },
    res,
  );
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.state, "failed", "execution failure is 'failed'; 'rejected' means the human said no");
  assert.equal(res.body.code, "upstream_422");
  assert.deepEqual(res.body.fields, [{ field: "source_urls.0", message: "non-public URL", type: "value_error" }]);
  const row = db.getDb().prepare("SELECT state, result_summary FROM action_proposals WHERE proposal_id = ?").get(id);
  assert.equal(row.state, "failed");
  assert.match(row.result_summary, /non-public URL/);
  const audit = db.getDb().prepare("SELECT error_text FROM action_audit WHERE proposal_id = ?").get(id);
  assert.match(audit.error_text, /upstream_422/);
});

test("3.2 approve on upstream 401 clears the credential and broadcasts line_credential_stale", async () => {
  connected();
  const id = await proposeDemand();
  const events = [];
  const invalidated = [];
  const ctx = {
    authEnabled: true,
    broadcast: (ev) => events.push(ev),
    actionExecutorDeps: {
      ...executorStub(() => ({ content: [{ type: "text", text: "[unauthorized] token expired (HTTP 401)" }], isError: true })),
      markInvalid: (e, r) => invalidated.push([e, r]),
    },
  };
  const res = mockRes();
  await actions.approveAction(
    {
      params: { id },
      body: { userArgs: { source_urls: ["https://x.test"], public_data_asserted: true } },
      user: { email: EMAIL },
      ctx,
    },
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.credentialInvalidated, true);
  assert.equal(res.body.credentialRef, "wire-customer");
  assert.deepEqual(invalidated, [[EMAIL, "wire-customer"]]);
  assert.ok(events.some((e) => e.type === "line_credential_stale" && e.line === "wire-customer"));
  const row = db.getDb().prepare("SELECT state FROM action_proposals WHERE proposal_id = ?").get(id);
  assert.equal(row.state, "failed");
});

// ── 5. WireBoardAdapter ──────────────────────────────────────────────────────

const DATASETS = [{ id: "ds_1", key: "sales", name: "销售台账", source_kind: "csv", storage_tier: "api", connector_id: null, source_name: null, source_ref: null, columns: [], row_count: 120 }];
const ARTIFACTS = [
  { id: 7, customer_id: "c1", kind: "form", title: "进货单", status: "draft", version: 2, origin_conversation_id: null, created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" },
  { id: 8, customer_id: "c1", kind: "record_view", title: "库存视图", status: "published", version: 1, origin_conversation_id: null, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" },
];
const DEMANDS = [
  { id: 3, code: "D-0003", customer_id: "c1", title: "竞品价格", intent: "monitor", status: "evaluating", status_history: [], created_at: "2026-10-19T08:00:00Z", updated_at: "2026-10-19T08:00:00Z" },
  { id: 4, code: "D-0004", customer_id: "c1", title: "门店清单", intent: "list", status: "queued", status_history: [], created_at: "2026-10-20T08:00:00Z", updated_at: "2026-10-20T08:00:00Z" },
];
const QUOTA = { plan_code: "free", used_datasets: 1, max_datasets: 3, max_rows_per_dataset: 1000 };

const jsonResponse = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });

function adapterWith({ token = "tok", fetchImpl, markInvalid = () => {} } = {}) {
  const calls = [];
  const invalidated = [];
  const a = new WireBoardAdapter({
    deps: {
      liveToken: () => token,
      markInvalid: (e, r) => { invalidated.push([e, r]); markInvalid(e, r); },
      fetch: async (url, init) => { calls.push({ url, auth: init?.headers?.Authorization }); return fetchImpl(url, calls); },
    },
  });
  return { adapter: a, calls, invalidated };
}

test("5.1 connected: four real blocks, counts, quota, deep links, row actions", async () => {
  const { adapter, calls } = adapterWith({
    fetchImpl: (url) => {
      if (url.endsWith("/api/v1/datasets/quota")) return jsonResponse(QUOTA);
      if (url.endsWith("/api/v1/datasets")) return jsonResponse(DATASETS);
      if (url.endsWith("/api/v1/artifacts")) return jsonResponse(ARTIFACTS);
      if (url.endsWith("/api/v1/demands")) return jsonResponse(DEMANDS);
      return jsonResponse({}, 404);
    },
  });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, true);
  assert.deepEqual(out.blocks.map((b) => b.id), ["overview_metrics", "datasets_list", "artifacts_list", "demands_timeline"]);
  assert.equal(calls.length, 4, "exactly the four upstream reads");
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
  const overview = out.blocks[0];
  // fix-line-boards-ux D3: metric keys are stable snake_case identifiers the
  // renderer localizes via board.metric.<key> — never raw display strings.
  assert.equal(overview.data.datasets, 1);
  assert.equal(overview.data.artifacts, 2);
  assert.equal(overview.data.demands, 2);
  assert.equal(overview.data.quota, "1/3");
  // D2: every block declares its owning tab (the page's tab contract).
  assert.deepEqual(out.blocks.map((b) => b.tab), ["overview", "datasets", "artifacts", "demands"]);
  const datasets = out.blocks[1];
  assert.equal(datasets.data[0].title, "销售台账");
  assert.equal(datasets.data[0].badges.join(","), "免费档,120 行");
  assert.equal(datasets.href, "https://wire.finddatatech.cloud/#/console/datasets");
  const artifacts = out.blocks[2];
  const draft = artifacts.data.find((r) => r.id === 7);
  const published = artifacts.data.find((r) => r.id === 8);
  assert.deepEqual(draft.rowActions.map((a) => a.id), ["wire.artifact.publish", "wire.artifact.archive"]);
  assert.deepEqual(published.rowActions.map((a) => a.id), ["wire.artifact.archive"]);
  const demands = out.blocks[3];
  assert.equal(demands.data[0].code, "D-0004", "newest first");
  assert.ok(demands.links.some((l) => l.href.endsWith("/console/demands/new")));
});

test("5.1 any 401 → credential cleared, board returns unconnected/expired, no stale-key semantics", async () => {
  const { adapter, invalidated } = adapterWith({
    fetchImpl: (url) => (url.endsWith("/api/v1/demands") ? jsonResponse({ detail: "no" }, 401) : jsonResponse(DATASETS)),
  });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, false);
  assert.equal(out.reason, "expired");
  assert.equal(out.connectPath, "/settings/connections?panel=line-wire-customer");
  assert.match(out.blocks[0].error, /重新授权/);
  assert.deepEqual(invalidated, [[EMAIL, "wire-customer"]], "ID-token line: clear, do not flip stale");
});

test("5.1 not connected: zero upstream calls", async () => {
  const { adapter, calls } = adapterWith({ token: null, fetchImpl: () => { throw new Error("must not be called"); } });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, false);
  assert.equal(out.reason, "not_connected");
  assert.equal(calls.length, 0);
});

test("5.1 single-block failure degrades alone", async () => {
  const { adapter } = adapterWith({
    fetchImpl: (url) => {
      if (url.endsWith("/api/v1/artifacts")) return jsonResponse({ detail: "boom" }, 500);
      if (url.endsWith("/api/v1/datasets/quota")) return jsonResponse(QUOTA);
      if (url.endsWith("/api/v1/datasets")) return jsonResponse(DATASETS);
      return jsonResponse(DEMANDS);
    },
  });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, true);
  const arts = out.blocks.find((b) => b.id === "artifacts_list");
  assert.match(arts.error, /HTTP 500/);
  assert.equal(out.blocks.find((b) => b.id === "datasets_list").data.length, 1);
  assert.deepEqual(out.blocks[0].partial, ["产物"], "overview names what it could not count");
});

// ── 3.4 / 8.3 the deployment switch on the server side ──────────────────────

test("3.4 GET /api/boards/:line is 404 line_boards_disabled until LINE_BOARDS_ENABLED=1; then the wire adapter answers", async () => {
  const { registerBoardRoutes } = await import("../server/routes/boards.js");
  const routes = {};
  registerBoardRoutes({ app: { get: (p, h) => { routes[p] = h; } } });
  const handler = routes["/api/boards/:line"];
  assert.equal(typeof handler, "function");

  const prev = process.env.LINE_BOARDS_ENABLED;
  try {
    delete process.env.LINE_BOARDS_ENABLED;
    const off = mockRes();
    await handler({ params: { line: "wire" }, user: { email: EMAIL } }, off);
    assert.equal(off.statusCode, 404);
    assert.equal(off.body.error, "line_boards_disabled");

    process.env.LINE_BOARDS_ENABLED = "1";
    lc.disconnect(EMAIL, "wire-customer");
    const on = mockRes();
    await handler({ params: { line: "wire" }, user: { email: EMAIL } }, on);
    assert.equal(on.statusCode, 200);
    assert.equal(on.body.line, "wire");
    assert.equal(on.body.connected, false, "no credential → unconnected, zero upstream calls");
    assert.equal(on.body.connectPath, "/settings/connections?panel=line-wire-customer");

    const unknown = mockRes();
    await handler({ params: { line: "nope" }, user: { email: EMAIL } }, unknown);
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(unknown.body.availableLines, ["facet", "wanxing", "wire", "lex"]);
  } finally {
    if (prev === undefined) delete process.env.LINE_BOARDS_ENABLED;
    else process.env.LINE_BOARDS_ENABLED = prev;
  }
});
