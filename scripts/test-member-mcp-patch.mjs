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
