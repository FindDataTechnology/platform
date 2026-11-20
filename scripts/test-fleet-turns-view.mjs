// The architect's turn-diagnosis page (fix-tool-result-cost).
//
// `fleet_turns_read` shipped up to 100 rows pretty-printed with every field —
// 2.3MB across one cell's traces, third largest tool result after the handoff
// list and `read`. The page now carries the diagnosis fields compactly and says
// whether it was truncated, so a caller cannot mistake a page for the whole set.
//
// The MCP module spawns a stdio server at import, so the pure view lives in
// server/fleet-turns-view.js and this suite is its test face.
//
// Run: node --test scripts/test-fleet-turns-view.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { shapeTurnsPage, TURNS_PAGE_DEFAULT, TURNS_PAGE_MAX } = await import("../server/fleet-turns-view.js");

const turn = (n, over = {}) => ({
  id: n,
  memberId: `m${n}`,
  source: "cron",
  status: "failed",
  errorKind: "timeout",
  error: "x".repeat(800),
  model: "deepseek",
  startedAt: 1000 + n,
  endedAt: 2000 + n,
  usage: { input: 1, output: 2 },
  turnId: `t${n}`,
  runId: "r1",
  parentTurnId: null,
  edgeKind: null,
  traceTurnId: "tr-1",
  detail: { kind: "turn_budget_exceeded", steps: 12 },
  ...over,
});

test("默认页与上限", () => {
  const body = shapeTurnsPage(Array.from({ length: 150 }, (_, i) => turn(i)));
  assert.equal(body.count, TURNS_PAGE_DEFAULT);
  assert.equal(body.page, TURNS_PAGE_DEFAULT);
  assert.equal(body.truncated, true);
  const big = shapeTurnsPage(Array.from({ length: 150 }, (_, i) => turn(i)), 9999);
  assert.equal(big.count, TURNS_PAGE_MAX, "clamped by the ceiling");
  assert.equal(shapeTurnsPage(Array.from({ length: 3 }, (_, i) => turn(i)), "abc").count, 3);
  assert.equal(shapeTurnsPage([], 10).truncated, false);
});

test("投影只留诊断字段，错误串有上限", () => {
  const [row] = shapeTurnsPage([turn(1)]).turns;
  for (const k of ["id", "memberId", "source", "status", "errorKind", "error", "model", "startedAt", "endedAt", "usage", "turnId", "runId", "parentTurnId", "edgeKind"]) {
    assert.ok(k in row, k);
  }
  assert.equal(row.error.length, 240, "an 800-char error is cut");
  assert.equal(row.traceTurnId, undefined, "internal ids do not ride the page");
  assert.equal(row.detail, undefined, "the executor's detail blob does not ride it either");
});

test("页比整份小一个数量级（这就是它存在的原因）", () => {
  const rows = Array.from({ length: 100 }, (_, i) => turn(i));
  const prettyBefore = JSON.stringify(rows, null, 2).length;
  const now = JSON.stringify(shapeTurnsPage(rows)).length;
  assert.ok(now * 8 < prettyBefore, `page ${now}B vs pretty ${prettyBefore}B`);
});

// ── roster page ─────────────────────────────────────────────────────────────
const { shapeFleetRoster, ROSTER_MAX } = await import("../server/fleet-turns-view.js");

const fleet = (n) => ({ id: `f${n}`, name: `舰队${n}`, state: "active", memberCount: 6, openDecisions: 2, failing: 1, orchestration: { big: "x".repeat(200) } });

test("名册默认全量（漏项=谎报不存在），只保留六个字段", () => {
  const all = Array.from({ length: 57 }, (_, i) => fleet(i));
  const body = shapeFleetRoster(all);
  assert.equal(body.count, 57, "57 fleets all ship");
  assert.equal(body.total, 57);
  assert.equal(body.truncated, false, "no cap reached → not truncated");
  assert.deepEqual(Object.keys(body.fleets[0]), ["id", "name", "state", "memberCount", "openDecisions", "failing"]);
  assert.equal(body.fleets[0].orchestration, undefined, "the heavy fields do not ride the roster");
});

test("病态规模有硬上限，且如实说被裁", () => {
  const huge = Array.from({ length: ROSTER_MAX + 5 }, (_, i) => fleet(i));
  const body = shapeFleetRoster(huge);
  assert.equal(body.count, ROSTER_MAX);
  assert.equal(body.total, ROSTER_MAX + 5);
  assert.equal(body.truncated, true);
  assert.equal(shapeFleetRoster([]).count, 0);
  assert.equal(shapeFleetRoster(null).truncated, false);
});

test("同一份名册紧凑后远小于美化输出", () => {
  const all = Array.from({ length: 57 }, (_, i) => fleet(i));
  const pretty = JSON.stringify(all, null, 2).length;
  const now = JSON.stringify(shapeFleetRoster(all)).length;
  assert.ok(now * 2 < pretty, `compact ${now}B vs pretty ${pretty}B`);
});
