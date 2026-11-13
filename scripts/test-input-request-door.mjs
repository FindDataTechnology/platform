// ── Input-request machine door (add-acp-input-request-owner) ────────────────
//
// Pins the three rules that make this door safe, each a failure we have a
// reason to fear rather than a style preference:
//   * an unauthenticated caller naming a cell (privilege escalation);
//   * a fallback to a default cell (one owner's card inside another's session);
//   * reading the owner header before the bearer passes (same escalation,
//     just earlier in the pipeline).
//
// The two halves that only the assembled app / the cell module can see are
// pinned too: the route must sit BEFORE the cell-proxy catch-all, and the path
// constant must equal the cell mount's.
//
// Run: node --test scripts/test-input-request-door.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { decideInputRequestDoor, INPUT_REQUEST_MCP_PATH, INPUT_REQUEST_OWNER_HEADER } = await import(
  "../gateway/input-request-door.js"
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "input-request-token-abc";
const CELLS = [
  { user: "owner-a@example.com", state: "running", port: 4101 },
  { user: "owner-b@example.com", state: "running", port: 4102 },
  { user: "idle@example.com", state: "starting", port: 4103 },
];

const decide = (over = {}) =>
  decideInputRequestDoor({
    configuredToken: TOKEN,
    authorization: `Bearer ${TOKEN}`,
    ownerHeader: "owner-a@example.com",
    runningCells: CELLS,
    ...over,
  });

test("door: 未配置部署与 cell 侧同形 404 not_configured——拒绝，不是放行", () => {
  const r = decide({ configuredToken: "" });
  assert.equal(r.status, 404);
  assert.equal(r.error, "not_configured");
  assert.equal(r.cell, undefined);
});

test("door: 错凭据与无凭据都是 401，且都不解析 owner", () => {
  assert.equal(decide({ authorization: "Bearer nope" }).status, 401);
  assert.equal(decide({ authorization: "" }).status, 401);
  const both = decide({ authorization: "Bearer nope", ownerHeader: "owner-a@example.com" });
  assert.equal(both.status, 401);
  assert.equal(both.cell, undefined, "凭据不过时不得解析出任何 cell");
});

test("door: 凭据过了但没有 owner → 400（不去猜）", () => {
  assert.equal(decide({ ownerHeader: "" }).status, 400);
  assert.equal(decide({ ownerHeader: "   " }).status, 400);
});

test("door: owner 大小写不敏感，解析到它自己那个 cell", () => {
  const r = decide({ ownerHeader: "Owner-A@Example.COM" });
  assert.equal(r.status, 200);
  assert.equal(r.cell.user, "owner-a@example.com");
  assert.equal(r.owner, "owner-a@example.com");
});

test("door: 点名谁就答谁，两个 owner 绝不落到同一台", () => {
  const a = decide({ ownerHeader: "owner-a@example.com" });
  const b = decide({ ownerHeader: "owner-b@example.com" });
  assert.equal(a.cell.port, 4101);
  assert.equal(b.cell.port, 4102);
  assert.notEqual(a.cell.port, b.cell.port);
});

test("door: 未知 owner 与「注册了但没在跑」都 404，不回落默认 cell", () => {
  const stranger = decide({ ownerHeader: "stranger@example.com" });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.cell, undefined, "回落即等于把 A 的卡放进 B 的会话");
  assert.equal(decide({ ownerHeader: "idle@example.com" }).status, 404);
});

test("door: 头名与路径就是规格里写的那个", () => {
  assert.equal(INPUT_REQUEST_OWNER_HEADER, "x-input-request-owner");
  assert.equal(INPUT_REQUEST_MCP_PATH, "/api/mcp/input-request/mcp");
});

test("door: 路径与 cell 侧挂载的常量一致（两处不能各自漂）", () => {
  const cellSrc = readFileSync(path.join(REPO_ROOT, "server", "input-request-http.js"), "utf8");
  const literal = cellSrc.match(/INPUT_REQUEST_MCP_PATH\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(literal, INPUT_REQUEST_MCP_PATH, "gateway 门与 cell 挂载的路径必须逐字相同");
});

test("door: 网关里真的接在 catch-all 之前（决策绿不代表接上了）", () => {
  const src = readFileSync(path.join(REPO_ROOT, "gateway", "index.js"), "utf8");
  const doorAt = src.indexOf("app.post(INPUT_REQUEST_MCP_PATH");
  const catchAllAt = src.indexOf("dispatchToCell(req, res, user);");
  assert.ok(doorAt > 0, "gateway/index.js 里没有这个门——决策函数再绿也是死代码");
  assert.ok(catchAllAt > doorAt, "门必须注册在 cell-proxy catch-all 之前");
  assert.ok(
    src.includes("decideInputRequestDoor("),
    "门里必须真的调用判定函数，而不是只 import",
  );
});
