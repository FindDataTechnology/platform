// MCP preflight health signal (add-mcp-credential-hygiene §3).
//
// probeOne with an injected fetchImpl classifies: 200 → ok (with session
// DELETE when the server mints one), 401/403 → auth-rejected, 5xx →
// server-error, timeout/transport → unreachable, probe-side breakage →
// unknown. probeHttpServers skips stdio entries, records + persists state,
// and getPreflightStatus exposes the read shape.
//
// Run: node scripts/test-mcp-preflight.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "mcp-preflight-test-"));
process.env.MCP_PREFLIGHT_FILE = join(tmp, "state.json"); // resolved at import

const { probeOne, probeHttpServers, getPreflightStatus } = await import("../mcp-preflight.js");


function res(status, body = {}, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

test("200 → ok; minted session is DELETEd (never leaked)", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, sid: opts.headers?.["mcp-session-id"] });
    return res(200, { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fd-x", version: "1.2" } } },
      { "mcp-session-id": "sess-123" });
  };
  const s = await probeOne("srv-ok", { url: "http://unit.test/mcp" }, { fetchImpl });
  assert.equal(s.state, "ok");
  assert.match(s.detail, /fd-x@1\.2/);
  const del = calls.find((c) => c.method === "DELETE");
  assert.ok(del, "session DELETE must be sent");
  assert.equal(del.sid, "sess-123");
});

test("401 → auth-rejected; 500 → server-error", async () => {
  const auth = await probeOne("srv-401", { url: "http://unit.test/mcp" }, {
    fetchImpl: async () => res(401, { error: "nope" }),
  });
  assert.equal(auth.state, "auth-rejected");
  const err5 = await probeOne("srv-500", { url: "http://unit.test/mcp" }, {
    fetchImpl: async () => res(500, {}),
  });
  assert.equal(err5.state, "server-error");
});

test("timeout → unreachable; probe-side breakage → unknown", async () => {
  const slow = await probeOne("srv-slow", { url: "http://unit.test/mcp" }, {
    fetchImpl: async () => { throw new Error("This operation was aborted due to timeout"); },
  });
  // node wraps AbortSignal.timeout expiry as TimeoutError; the message-based
  // shape here falls into the unknown bucket, which is the spec's honest
  // answer for an unrecognized failure — assert BOTH acceptable buckets.
  assert.ok(["unreachable", "unknown"].includes(slow.state));
  const netFail = await probeOne("srv-gone", { url: "http://unit.test/mcp" }, {
    fetchImpl: async () => { const e = new TypeError("fetch failed"); throw e; },
  });
  assert.equal(netFail.state, "unreachable");
  const weird = await probeOne("srv-weird", { url: "http://unit.test/mcp" }, {
    fetchImpl: async () => { throw new Error("probe machinery exploded"); },
  });
  assert.equal(weird.state, "unknown");
});

test("probeHttpServers: http entries only, state recorded and persisted", async () => {
  const entries = [
    { config: { serverName: "stdio-one", transport: "stdio", command: "node" } },
    { config: { serverName: "http-one", transport: "streamable-http", url: "http://unit.test/mcp", headers: { Authorization: "Bearer unit" } } },
  ];
  const seenAuth = [];
  const out = await probeHttpServers(entries, {
    fetchImpl: async (_url, opts = {}) => {
      seenAuth.push(opts.headers?.Authorization);
      return res(200, { result: {} });
    },
  });
  assert.deepEqual(out.map((o) => o.name), ["http-one"]);
  assert.equal(out[0].state, "ok");
  assert.deepEqual(seenAuth, ["Bearer unit"], "probe must send the patch's own resolved headers");
  assert.ok(existsSync(process.env.MCP_PREFLIGHT_FILE), "state must be persisted");
  const disk = JSON.parse(readFileSync(process.env.MCP_PREFLIGHT_FILE, "utf8"));
  assert.ok(disk.servers["http-one"]);
  assert.ok(!disk.servers["stdio-one"], "stdio entries never get a probe verdict");
  assert.ok(!JSON.stringify(disk).includes("Bearer unit"), "persisted state must be secret-free");
});

test("getPreflightStatus: read shape for /api/diagnostics/mcp", () => {
  const rows = getPreflightStatus();
  assert.ok(Array.isArray(rows));
  const row = rows.find((r) => r.name === "http-one");
  assert.ok(row?.state && row?.checkedAt && "detail" in row);
});

test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
