// ── Runner-fleet machine door (add-fleet-bridge-endpoint-for-agent-runner 4.3) ─
//
// Pins the three rules that make this door safe — each one a failure we have a
// reason to fear, not a style preference:
//   * an unauthenticated caller naming a cell (privilege escalation);
//   * a fallback to a default cell (one owner's fleet roster inside another
//     owner's turn);
//   * reading the owner header before the bearer passes (same escalation,
//     earlier in the pipeline).
//
// It also pins the two halves only the assembled app / the other modules can
// see: the route must sit BEFORE the cell-proxy catch-all, and the owner header
// string must be the one the child actually sends. That last pin exists because
// this bug class is invisible from either side alone — the gateway suite stays
// green while the child sends a slightly different header, and the only symptom
// is a 400 on the read face at 3am.
//
// Why this door exists at all: measured 2026-11-14, `:3100` is the gateway and
// the cells listen on 127.0.0.1:<random> behind it. The cell-side
// `runnerFleetGate` never saw a bridge request — the catch-all answered 401
// with the same body, so a byte-identical token looked "wrong" for two hours.
//
// Run: node --test scripts/test-runner-fleet-door.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  decideRunnerFleetDoor,
  FLEET_OWNER_HEADER,
  RUNNER_FLEET_PATH_PREFIX,
  RUNNER_FLEET_PATH_RE,
} = await import("../gateway/runner-fleet-door.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "runner-fleet-token-abc";
const CELLS = [
  { user: "owner-a@example.com", state: "running", port: 4101 },
  { user: "owner-b@example.com", state: "running", port: 4102 },
  { user: "idle@example.com", state: "starting", port: 4103 },
];

const decide = (over = {}) =>
  decideRunnerFleetDoor({
    configuredToken: TOKEN,
    authorization: `Bearer ${TOKEN}`,
    ownerHeader: "owner-a@example.com",
    runningCells: CELLS,
    ...over,
  });

test("door: 未配置部署回 503，与 cell 侧 runnerFleetGate 同形——拒绝，不是放行", () => {
  const r = decide({ configuredToken: "" });
  assert.equal(r.status, 503);
  assert.equal(r.error, "runner fleet bridge not configured");
  assert.equal(r.cell, undefined);
});

test("door: 错凭据与无凭据都是 401，且都不解析 owner", () => {
  assert.equal(decide({ authorization: "Bearer nope" }).status, 401);
  assert.equal(decide({ authorization: "" }).status, 401);
  const both = decide({ authorization: "Bearer nope", ownerHeader: "owner-a@example.com" });
  assert.equal(both.status, 401);
  assert.equal(both.cell, undefined, "凭据不过时不得解析出任何 cell");
});

test("door: 凭据过了但没有 owner → 400（fleet_list 没有 turn_token 可反查，所以不许猜）", () => {
  assert.equal(decide({ ownerHeader: "" }).status, 400);
  assert.equal(decide({ ownerHeader: "   " }).status, 400);
  assert.match(decide({ ownerHeader: "" }).error, /x-fleet-owner/);
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

test("door: 没在跑的 cell 给 null（由 wire 去 ensure），而不是回落别人的 cell", () => {
  const idle = decide({ ownerHeader: "idle@example.com" });
  assert.equal(idle.status, 200);
  assert.equal(idle.cell, null, "冷 cell 不能等于「换一台」");
  const stranger = decide({ ownerHeader: "stranger@example.com" });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.cell, null);
});

test("door: 头名与路径就是规格里写的那个", () => {
  assert.equal(FLEET_OWNER_HEADER, "x-fleet-owner");
  assert.equal(RUNNER_FLEET_PATH_PREFIX, "/api/runner-fleet");
});

test("door: 路径正则既收 /api/runner-fleet 也收其子路径，且不收相似前缀", () => {
  assert.ok(RUNNER_FLEET_PATH_RE.test("/api/runner-fleet"));
  assert.ok(RUNNER_FLEET_PATH_RE.test("/api/runner-fleet/fleets/report"));
  assert.ok(RUNNER_FLEET_PATH_RE.test("/api/runner-fleet/architect/fleets"));
  assert.ok(!RUNNER_FLEET_PATH_RE.test("/api/runner-fleet-extra"));
  assert.ok(!RUNNER_FLEET_PATH_RE.test("/api/fleets"));
});

test("door: owner 头与 child 出站那一处逐字相同（两侧不能各自漂）", () => {
  const hints = readFileSync(path.join(REPO_ROOT, "server", "fleet-mcp-hints.js"), "utf8");
  const literal = hints.match(/FLEET_OWNER_HEADER\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(literal, FLEET_OWNER_HEADER, "gateway 门与 fleet-mcp-hints 的头名必须逐字相同");
});

test("door: runner 侧的桥前缀与网关前缀一致", () => {
  const bridgeSrc = readFileSync(path.join(REPO_ROOT, "agent-runner", "fleet-bridge.js"), "utf8");
  // The prefix now lives in ONE constant — the child env and the row header both
  // derive from it, because a base spelled twice is a base that drifts (live
  // 2026-11-15: the row carried the satellite origin, so every call answered
  // `unknown satellite endpoint`). So pin the literal on the constant, and
  // require the env to consume that constant rather than re-spell it.
  const literal = bridgeSrc.match(/FLEET_BRIDGE_MOUNT\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(literal, RUNNER_FLEET_PATH_PREFIX, "child 出站前缀必须落在网关门上");
  assert.match(
    bridgeSrc,
    /FLEET_MCP_BRIDGE_PREFIX:\s*FLEET_BRIDGE_MOUNT/,
    "child env 必须用同一个常量，不能再写一份字面量",
  );
});

test("door: 网关里真的接在 catch-all 之前（决策绿不代表接上了）", () => {
  const src = readFileSync(path.join(REPO_ROOT, "gateway", "index.js"), "utf8");
  const doorAt = src.indexOf("app.all(RUNNER_FLEET_PATH_RE");
  const catchAllAt = src.indexOf("dispatchToCell(req, res, user);");
  assert.ok(doorAt > 0, "gateway/index.js 里没有这个门——决策函数再绿也是死代码");
  assert.ok(catchAllAt > doorAt, "门必须注册在 cell-proxy catch-all 之前");
  assert.ok(src.includes("decideRunnerFleetDoor("), "门里必须真的调用判定函数，而不是只 import");
  assert.ok(
    src.includes("machineHeaders(req, SECRET)"),
    "转发必须走 machine headers：cell 的 runnerFleetGate 拒绝带 x-forwarded-email 的请求",
  );
});

test("door: 转发不带用户身份头（带 bearer 又带 x-forwarded-email 会被 cell 拒）", () => {
  const proxySrc = readFileSync(path.join(REPO_ROOT, "gateway", "proxy.js"), "utf8");
  const block = proxySrc.slice(
    proxySrc.indexOf("const IDENTITY_HEADERS"),
    proxySrc.indexOf("]", proxySrc.indexOf("const IDENTITY_HEADERS")),
  );
  assert.match(block, /"x-forwarded-email"/, "machineHeaders 必须剔除 x-forwarded-email");
  assert.doesNotMatch(block, /"authorization"/, "machineHeaders 不得剔除 bearer");
});
