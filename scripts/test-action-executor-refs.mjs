// Unit tests — action executor credential-ref dispatch for the facet/wanxing
// lines (add-line-boards-and-action-gate, executor wiring 2026-10-21).
// Run: node --test scripts/test-action-executor-refs.mjs
//
//   1.x  resolveCredentialRef precedence: action declaration → line fixed ref
//        (wire) → hosting server's registry declaration (facet-market / none ⇒
//        registry) → null when the catalog does not know the server; the
//        catalog snapshot is an OBJECT ({ mcpServers }) and must not throw.
//   2.x  execution: a facet-market action presents the facet-market token to
//        its declared server; a registry-ref action presents the user's stored
//        registry token through the credential-refs table (no stubs).
//   3.x  401: an HTTP-layer 401 (auth gate before any tool) and a tool-level
//        "unauthorized" text both fail upstream_401 and invalidate THAT ref —
//        through the table for the real registry credential (stale flips).
//   4.x  honesty: unknown tool at the server is tool_error without
//        invalidation; wanxing.agent.deploy (no upstream tool yet) is
//        tool_unroutable, not a credential complaint.
//   5.x  preflight: requireExecutionCredential refuses on a cold catalog,
//        refuses with the ref's connect pointer when unconnected, passes when
//        the resolved ref holds a live token; the dispatcher hands the action
//        to the hook.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "action-refs-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const registryCredentials = await import("../registry-credentials.js");
const registry = await import("../lib/action-registry.js");
const preflight = await import("../lib/action-preflight.js");
const {
  executeRegisteredAction,
  marketEntryFor,
  resolveCredentialRef,
  resolveServerEndpoint,
} = await import("../lib/action-executor.js");

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const EMAIL = "line-owner@test.example";
const action = (id) => registry.getAction(id);

// A real Streamable HTTP MCP server. `httpStatus` short-circuits every POST
// with that status (the auth-gate shape); `onCall` scripts the tool result.
async function startFakeMcp({ toolName = "x", onCall = null, httpStatus = null } = {}) {
  const seen = { auth: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization ?? null);
    let body = "";
    for await (const chunk of req) body += chunk;
    if (httpStatus) {
      res.writeHead(httpStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Authentication required" }));
      return;
    }
    const mcp = new Server({ name: "fake-line", version: "0.1.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: toolName, description: "x", inputSchema: { type: "object" } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen.calls.push(request.params);
      if (onCall) return onCall(request.params);
      return { content: [{ type: "text", text: `${request.params.name} ok` }] };
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
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ENTRIES = [
  { name: "facet-market-mcp", credentialRef: "facet-market", configTemplate: { url: "http://market.test/mcp" } },
  { name: "facet-ops-mcp", credentialRef: null, configTemplate: { url: "http://ops.test/mcp" } },
  { name: "wanxing-ops-mcp", credentialRef: null, configTemplate: { url: "http://wanxing.test/mcp" } },
];
const entryFor = (name) => marketEntryFor(name, { entries: ENTRIES });

// ── 1. ref resolution ────────────────────────────────────────────────────────

test("1.1 ref precedence: declaration, then line, then the server's registry entry", () => {
  assert.equal(resolveCredentialRef({ line: "facet", credentialRef: "custom" }, "facet-market-mcp", { entryFor }), "custom");
  assert.equal(resolveCredentialRef(action("wire.demand.submit"), null, { entryFor }), "wire-customer");
  assert.equal(resolveCredentialRef(action("facet.pack.visibility"), "facet-market-mcp", { entryFor }), "facet-market");
  assert.equal(resolveCredentialRef(action("facet.agent.toggle"), "facet-ops-mcp", { entryFor }), "registry");
  // The four wanxing ops entries pin wanxing-caller even though the registry
  // entry declares none — the operator baseline presents that key, and a wrong
  // registry token would 401 AND stale the user's market credential.
  assert.equal(resolveCredentialRef(action("wanxing.agent.pause"), "wanxing-ops-mcp", { entryFor }), "wanxing-caller");
  assert.equal(resolveCredentialRef(action("wanxing.callers.remove"), "wanxing-ops-mcp", { entryFor }), "wanxing-caller");
  assert.equal(resolveCredentialRef(action("facet.pack.visibility"), "not-in-catalog", { entryFor }), null);
  assert.equal(resolveCredentialRef(action("facet.pack.visibility"), null, { entryFor }), null);
});

test("1.2 every facet/wanxing entry except deploy declares its hosting server", () => {
  for (const id of ["facet.pack.publish", "facet.pack.visibility", "facet.pack.curation"]) {
    assert.equal(action(id).server, "facet-market-mcp", id);
  }
  assert.equal(action("facet.agent.toggle").server, "facet-ops-mcp");
  for (const id of ["wanxing.agent.pause", "wanxing.agent.resume", "wanxing.callers.add", "wanxing.callers.remove"]) {
    assert.equal(action(id).server, "wanxing-ops-mcp", id);
  }
  assert.equal(action("wanxing.agent.deploy").server, undefined);
});

test("1.3 the real catalog snapshot is an object and never throws", () => {
  // No refresh has run: the snapshot is { mcpServers: [], skills: [] }.
  assert.equal(marketEntryFor("facet-market-mcp"), null);
  assert.equal(resolveServerEndpoint("facet-market-mcp", { registryUrl: "http://reg.test" }), "http://reg.test/facet-market-mcp/mcp");
  assert.equal(resolveServerEndpoint("facet-market-mcp", { entries: ENTRIES }), "http://market.test/mcp");
});

// ── 2. execution with the resolved ref ───────────────────────────────────────

test("2.1 a facet-market action presents the facet-market token to its declared server", async () => {
  const fake = await startFakeMcp({ toolName: "facet_market_pack_visibility" });
  try {
    const asked = [];
    const result = await executeRegisteredAction({
      action: action("facet.pack.visibility"),
      args: { id: "pk1", visibility: "private" },
      email: EMAIL,
      deps: {
        resolveEndpoint: (server) => (server === "facet-market-mcp" ? fake.url : null),
        resolveRef: (a, server) => resolveCredentialRef(a, server, { entryFor }),
        liveToken: (owner, ref) => {
          asked.push([owner, ref]);
          return ref === "facet-market" ? "device-tok" : null;
        },
      },
    });
    assert.deepEqual(asked, [[EMAIL, "facet-market"]]);
    // initialize / initialized / tools/call / session close — every hop carries
    // the same bearer, none carries anything else.
    assert.ok(fake.seen.auth.length >= 2);
    assert.deepEqual(new Set(fake.seen.auth), new Set(["Bearer device-tok"]));
    assert.equal(fake.seen.calls[0].name, "facet_market_pack_visibility");
    assert.deepEqual(fake.seen.calls[0].arguments, { id: "pk1", visibility: "private" });
    assert.equal(result.summary, "facet_market_pack_visibility ok");
    assert.equal(result.server, "facet-market-mcp");
  } finally {
    await fake.stop();
  }
});

test("2.2 a registry-ref action presents the stored registry token via the credential-refs table", async () => {
  registryCredentials.store({ email: EMAIL, token: "reg-tok" });
  const fake = await startFakeMcp({ toolName: "facet_agent_toggle" });
  try {
    const result = await executeRegisteredAction({
      action: action("facet.agent.toggle"),
      args: { path: "/x", enabled: false },
      email: EMAIL,
      deps: {
        resolveEndpoint: () => fake.url,
        resolveRef: (a, server) => resolveCredentialRef(a, server, { entryFor }),
        // no liveToken / markInvalid stubs: the table resolves "registry"
      },
    });
    assert.ok(fake.seen.auth.length >= 2);
    assert.deepEqual(new Set(fake.seen.auth), new Set(["Bearer reg-tok"]));
    assert.equal(result.server, "facet-ops-mcp");
  } finally {
    await fake.stop();
    registryCredentials.disconnect(EMAIL);
  }
});

test("2.3 a wanxing action presents the user's caller key, resolved via the table (ciyuan → legacy)", async () => {
  const lc = await import("../line-credentials.js");
  lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-live" });
  const fake = await startFakeMcp({ toolName: "wanxing_agent_pause" });
  try {
    const result = await executeRegisteredAction({
      action: action("wanxing.agent.pause"),
      args: { agentId: "a1", packId: "p1" },
      email: EMAIL,
      deps: {
        resolveEndpoint: () => fake.url,
        resolveRef: (a, server) => resolveCredentialRef(a, server, { entryFor }),
        // no liveToken stub: the table resolves wanxing-caller
      },
    });
    assert.ok(fake.seen.auth.length >= 2);
    assert.deepEqual(new Set(fake.seen.auth), new Set(["Bearer sk-live"]));
    assert.equal(result.server, "wanxing-ops-mcp");
  } finally {
    await fake.stop();
    lc.disconnect(EMAIL, "wanxing-caller");
  }
});

// ── 3. 401 at either layer invalidates the ref that was presented ────────────

test("3.1 HTTP-layer 401 (auth gate) → upstream_401 + markInvalid(email, ref)", async () => {
  const fake = await startFakeMcp({ httpStatus: 401 });
  const invalidated = [];
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("facet.agent.toggle"),
        args: { path: "/x", enabled: false },
        email: EMAIL,
        deps: {
          resolveEndpoint: () => fake.url,
          resolveRef: () => "registry",
          liveToken: () => "stale-tok",
          markInvalid: (owner, ref) => invalidated.push([owner, ref]),
        },
      }),
      (err) => err.code === "upstream_401" && err.credentialInvalidated === true && err.ref === "registry" && err.status === 401,
    );
    assert.deepEqual(invalidated, [[EMAIL, "registry"]]);
  } finally {
    await fake.stop();
  }
});

test("3.2 HTTP-layer 401 flips the REAL registry credential stale through the table", async () => {
  registryCredentials.store({ email: EMAIL, token: "reg-tok" });
  assert.equal(registryCredentials.status(EMAIL).connected, true);
  const fake = await startFakeMcp({ httpStatus: 401 });
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wanxing.callers.add"),
        args: { agentId: "a1", email: "c@x" },
        email: EMAIL,
        deps: { resolveEndpoint: () => fake.url, resolveRef: () => "registry" },
      }),
      (err) => err.code === "upstream_401",
    );
    assert.equal(registryCredentials.status(EMAIL).connected, false, "registry credential must be stale after 401");
  } finally {
    await fake.stop();
    registryCredentials.disconnect(EMAIL);
  }
});

test("3.3 tool-level unauthorized text without the wire envelope → upstream_401 + invalidation", async () => {
  const fake = await startFakeMcp({
    toolName: "wanxing_agent_resume",
    onCall: () => ({ isError: true, content: [{ type: "text", text: "Unauthorized: platform token rejected" }] }),
  });
  const invalidated = [];
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wanxing.agent.resume"),
        args: { agentId: "a1" },
        email: EMAIL,
        deps: {
          resolveEndpoint: () => fake.url,
          resolveRef: () => "registry",
          liveToken: () => "tok",
          markInvalid: (owner, ref) => invalidated.push([owner, ref]),
        },
      }),
      (err) => err.code === "upstream_401" && /Unauthorized/.test(err.message),
    );
    assert.deepEqual(invalidated, [[EMAIL, "registry"]]);
  } finally {
    await fake.stop();
  }
});

// ── 4. honesty on the failure shapes that are NOT credential problems ─────────

test("4.1 unknown tool at the server is tool_error and does not touch the credential", async () => {
  const fake = await startFakeMcp({
    toolName: "wanxing_agent_pause",
    onCall: () => ({ isError: true, content: [{ type: "text", text: "Unknown tool: wanxing_agent_pause" }] }),
  });
  const invalidated = [];
  try {
    await assert.rejects(
      executeRegisteredAction({
        action: action("wanxing.agent.pause"),
        args: {},
        email: EMAIL,
        deps: {
          resolveEndpoint: () => fake.url,
          resolveRef: () => "registry",
          liveToken: () => "tok",
          markInvalid: (owner, ref) => invalidated.push([owner, ref]),
        },
      }),
      (err) => err.code === "tool_error",
    );
    assert.deepEqual(invalidated, []);
  } finally {
    await fake.stop();
  }
});

test("4.2 wanxing.agent.deploy is tool_unroutable until the upstream tool exists", async () => {
  await assert.rejects(
    executeRegisteredAction({
      action: action("wanxing.agent.deploy"),
      args: { agentId: "a1", packId: "p1", target: "cloud" },
      email: EMAIL,
      deps: { resolveEndpoint: () => "http://127.0.0.1:1/mcp", liveToken: () => "tok" },
    }),
    (err) => err.code === "tool_unroutable",
  );
});

test("4.3 a server the catalog does not know fails credential_ref_unknown, not credential_missing", async () => {
  await assert.rejects(
    executeRegisteredAction({
      action: action("facet.pack.visibility"),
      args: {},
      email: EMAIL,
      deps: { resolveEndpoint: () => "http://127.0.0.1:1/mcp", liveToken: () => "tok" },
    }),
    (err) => err.code === "credential_ref_unknown",
  );
});

// ── 5. preflight ─────────────────────────────────────────────────────────────

test("5.1 requireExecutionCredential: cold catalog refuses by name, not by credential", async () => {
  const hook = preflight.requireExecutionCredential();
  const out = await hook({ email: EMAIL }, {}, action("facet.pack.visibility"));
  assert.equal(out.ok, false);
  assert.match(out.details, /facet-market-mcp/);
  assert.equal(out.connectPath, undefined);
});

test("5.2 requireExecutionCredential: unconnected → the ref's connect pointer; connected → ok", async () => {
  const hook = preflight.requireExecutionCredential({ entryFor });
  const refused = await hook({ email: EMAIL }, {}, action("facet.pack.visibility"));
  assert.equal(refused.ok, false);
  assert.equal(refused.credentialRef, "facet-market");
  assert.equal(refused.connectPath, "/settings/connections?panel=facet-market");
  assert.match(refused.details, /谦面市场/);

  const unconnectedRegistry = await hook({ email: EMAIL }, {}, action("facet.agent.toggle"));
  assert.equal(unconnectedRegistry.ok, false);
  assert.equal(unconnectedRegistry.credentialRef, "registry");
  assert.equal(unconnectedRegistry.connectPath, "/settings/connections?panel=registry");

  // wanxing ops actions require the caller key (词元账号 panel), not the registry
  const unconnectedCaller = await hook({ email: EMAIL }, {}, action("wanxing.agent.pause"));
  assert.equal(unconnectedCaller.ok, false);
  assert.equal(unconnectedCaller.credentialRef, "wanxing-caller");
  assert.equal(unconnectedCaller.connectPath, "/settings/connections?panel=ciyuan-account");
  assert.match(unconnectedCaller.details, /词元账号/);

  registryCredentials.store({ email: EMAIL, token: "reg-tok" });
  try {
    assert.deepEqual(await hook({ email: EMAIL }, {}, action("facet.agent.toggle")), { ok: true });
  } finally {
    registryCredentials.disconnect(EMAIL);
  }
});

test("5.3 preflightAction hands the action to the registry hook (facet entries are no longer unconditional ok)", async () => {
  const out = await preflight.preflightAction(action("facet.pack.visibility"), { email: EMAIL }, {});
  assert.equal(out.ok, false);
  assert.match(out.details, /尚未进入市场目录/);
});

// ── 6. rollback levers (tasks 8.3) ───────────────────────────────────────────

test("6.1 LINE_BOARDS_ENABLED is opt-in; COPILOT_ENABLED is a kill switch (only \"0\" closes it)", async () => {
  const { copilotEnabled, lineBoardsEnabled } = await import("../lib/board-adapters.js");
  assert.equal(lineBoardsEnabled({}), false);
  assert.equal(lineBoardsEnabled({ LINE_BOARDS_ENABLED: "1" }), true);
  assert.equal(lineBoardsEnabled({ LINE_BOARDS_ENABLED: "true" }), false);
  assert.equal(copilotEnabled({}), true);
  assert.equal(copilotEnabled({ COPILOT_ENABLED: "1" }), true);
  assert.equal(copilotEnabled({ COPILOT_ENABLED: "0" }), false);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
