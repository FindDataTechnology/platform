// add-member-knowledge-profile: the per-member MCP patch override math (pure)
// and the worker-slot attach contract. The fd-memory row carries the MEMBER's
// deployment token, the library row carries the member's bound collections
// (LIBRARY_COLLECTIONS env, library: prefix stripped), memory off DROPS the
// row (tools do not appear — never a dead entry), everything else rides
// verbatim. Path safety: a hostile persona id cannot escape the profiles dir.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMemberOverrides } from "../dsh-profile.js";

const rows = () => [
  { id: "mcp-fd-memory", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fd-memory", transport: "streamable-http", url: "http://mem.test/mcp", headers: { Authorization: "Bearer person-token" } } },
  { id: "mcp-library", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "library", transport: "stdio", command: "node", args: ["server/library-mcp.js"] } },
  { id: "mcp-cron", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "cron", transport: "stdio", command: "node", args: ["server/cron-mcp.js"] } },
];

test("member token replaces the person token on the fd-memory row", () => {
  const out = applyMemberOverrides(rows(), { memoryToken: "member-tok", libraryCollections: [] });
  const mem = out.find((e) => e.config.serverName === "fd-memory");
  assert.equal(mem.config.headers.Authorization, "Bearer member-tok");
  assert.equal(out.length, 3, "nothing dropped when memory is on");
  const lib = out.find((e) => e.config.serverName === "library");
  assert.equal(lib.config.env, undefined, "no collections → library row byte-identical (no env key added)");
});

test("library collections stamped into LIBRARY_COLLECTIONS (prefix stripped)", () => {
  const out = applyMemberOverrides(rows(), { memoryToken: "t", libraryCollections: ["library:col-a", "library:col-b"] });
  const lib = out.find((e) => e.config.serverName === "library");
  assert.equal(lib.config.env.LIBRARY_COLLECTIONS, "col-a,col-b");
});

test("memory off (token null) DROPS the fd-memory row entirely", () => {
  const out = applyMemberOverrides(rows(), { memoryToken: null, libraryCollections: [] });
  assert.equal(out.find((e) => e.config.serverName === "fd-memory"), undefined);
  assert.equal(out.length, 2, "library + cron remain");
});

test("unrelated servers ride verbatim (deep-equal row)", () => {
  const base = rows();
  const out = applyMemberOverrides(base, { memoryToken: "t", libraryCollections: ["library:x"] });
  assert.deepEqual(out.find((e) => e.config.serverName === "cron"), base[2]);
});

test("the person token never survives a member patch", () => {
  const out = applyMemberOverrides(rows(), { memoryToken: "member-tok", libraryCollections: ["library:x"] });
  assert.ok(!JSON.stringify(out).includes("person-token"), "owner credential cannot leak into the member face");
});

// ── fix-report-attribution-concurrency 2.1：岗位身份写进成员 patch ──────────────
//
// 报数归属需要一个**服务端写入**的坐标，模型改不了它。这个 env 只落进该 worker
// 的私有 patch，所以它读到的只能是自己的身份。

const rowsWithFleet = () => [
  ...rows(),
  { id: "mcp-fleet", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fleet", transport: "stdio", command: "node", args: ["server/fleet-mcp.js"] } },
];

test("fleet row gains the member identity env AND headers when the caller supplies it", () => {
  const out = applyMemberOverrides(rowsWithFleet(), {
    memoryToken: "t",
    libraryCollections: [],
    fleetIdentity: { fleetId: "fleet_1", memberId: "m_1", persona: "user.preset-7" },
  });
  const fleet = out.find((e) => e.config.serverName === "fleet");
  assert.equal(fleet.config.env.FLEET_MCP_FLEET_ID, "fleet_1");
  assert.equal(fleet.config.env.FLEET_MCP_MEMBER_ID, "m_1");
  assert.equal(fleet.config.env.FLEET_MCP_PERSONA, "user.preset-7");
  // 现役通道（2026-11-12 生产实测修正）：fleet 是**共用卫星**，client 配置的 env
  // 没有进程会继承；身份必须走 headers，由 mcp-satellite-host 逐请求带过去。
  assert.equal(fleet.config.headers["X-Fleet-Fleet-Id"], "fleet_1");
  assert.equal(fleet.config.headers["X-Fleet-Member-Id"], "m_1");
  assert.equal(fleet.config.headers["X-Fleet-Persona"], "user.preset-7");
});

test("identity headers never overwrite an existing Authorization header", () => {
  const rowsWithAuth = () => [
    { id: "mcp-fleet", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "fleet", transport: "streamable-http", url: "http://127.0.0.1:1/fleet/mcp", headers: { Authorization: "Bearer keep-me" } } },
  ];
  const out = applyMemberOverrides(rowsWithAuth(), {
    memoryToken: "t",
    libraryCollections: [],
    fleetIdentity: { fleetId: "fleet_1", memberId: "m_1" },
  });
  const fleet = out.find((e) => e.config.serverName === "fleet");
  assert.equal(fleet.config.headers.Authorization, "Bearer keep-me", "既有凭据不得被身份写入挤掉");
  assert.equal(fleet.config.headers["X-Fleet-Member-Id"], "m_1");
});

test("no identity ⇒ no env and no identity headers (缺坐标就不冒充，服务端会诚实拒收)", () => {
  const out = applyMemberOverrides(rowsWithFleet(), { memoryToken: "t", libraryCollections: [] });
  const fleet = out.find((e) => e.config.serverName === "fleet");
  assert.equal(fleet.config.env, undefined, "不得写入空串坐标");
  assert.equal(fleet.config.headers, undefined, "也不得写入空的身份头");
});

test("identity never leaks onto other servers", () => {
  const out = applyMemberOverrides(rowsWithFleet(), {
    memoryToken: "t",
    libraryCollections: ["library:x"],
    fleetIdentity: { fleetId: "fleet_1", memberId: "m_1", persona: "p" },
  });
  const lib = out.find((e) => e.config.serverName === "library");
  assert.deepEqual(Object.keys(lib.config.env), ["LIBRARY_COLLECTIONS"], "library row carries only its own env");
  assert.ok(!JSON.stringify(out.find((e) => e.config.serverName === "fd-memory").config).includes("fleet_1"));
});
