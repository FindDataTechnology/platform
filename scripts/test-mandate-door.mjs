// ── Disclosure-gate machine door (fix-disclosure-gate-reachability) ─────────
//
// Pins the three rules that make the gateway door safe. Each one is a failure
// we have a reason to fear, not a style preference:
//   * an unauthenticated caller naming a cell (would be privilege escalation);
//   * a fallback to some default cell (would answer A's text with B's policy);
//   * reading the owner header before the bearer passes (same escalation,
//     just earlier in the pipeline).
//
// The order assertion (door BEFORE the cell-proxy catch-all) lives in
// scripts/test-gateway-assembly.mjs, because only the assembled app can see it.
//
// Run: node --test scripts/test-mandate-door.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { decideMandateDoor, MANDATE_OWNER_HEADER } = await import("../gateway/mandate-door.js");

const TOKEN = "verdict-token-abc";
const CELLS = [
  { user: "owner-a@example.com", state: "running", port: 4101 },
  { user: "owner-b@example.com", state: "running", port: 4102 },
  { user: "idle@example.com", state: "starting", port: 4103 },
];

const decide = (over = {}) =>
  decideMandateDoor({
    configuredToken: TOKEN,
    authorization: `Bearer ${TOKEN}`,
    ownerHeader: "owner-a@example.com",
    runningCells: CELLS,
    ...over,
  });

test("door: 未配置部署回 503——拒绝，不是放行", () => {
  const r = decide({ configuredToken: "" });
  assert.equal(r.status, 503);
  assert.equal(r.cell, undefined);
});

test("door: 错凭据与无凭据同形 401，且都不解析 owner", () => {
  assert.equal(decide({ authorization: "Bearer nope" }).status, 401);
  assert.equal(decide({ authorization: "" }).status, 401);
  // 关键：即使 owner 头点名了一个真实存在的 cell，凭据不过也拿不到它
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

test("door: 点名另一个 cell 就答另一个，不串", () => {
  const a = decide({ ownerHeader: "owner-a@example.com" });
  const b = decide({ ownerHeader: "owner-b@example.com" });
  assert.equal(a.cell.port, 4101);
  assert.equal(b.cell.port, 4102);
  assert.notEqual(a.cell.port, b.cell.port, "两个 cell 的裁决绝不能落到同一台");
});

test("door: 未知 owner → 404，且不回落任何默认 cell", () => {
  const r = decide({ ownerHeader: "stranger@example.com" });
  assert.equal(r.status, 404);
  assert.equal(r.cell, undefined, "回落即等于拿 A 的文本问 B 的策略");
});

test("door: 注册了但没在跑 → 404（没在跑就没有对外回合，失败关闭是对的）", () => {
  const r = decide({ ownerHeader: "idle@example.com" });
  assert.equal(r.status, 404);
});

test("door: 头名就是规格里写的那个，改名字要同步改规格", () => {
  assert.equal(MANDATE_OWNER_HEADER, "x-mandate-owner");
});
