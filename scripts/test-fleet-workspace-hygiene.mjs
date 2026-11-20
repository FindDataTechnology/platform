// Workspace hygiene as a measured fact (fix-fleet-workspace-hygiene).
//
// The patrol discipline tail has told posts "don't write round files, don't
// read the old ones" since 2026-10-29. Production still held **358 files /
// 26MB** in one cell's shared workspace — every one a `DUTYLOG-*` /
// `BOARD-ENTRY-*` / `TICKET-DISPATCH-*` written by a post that wanted to
// remember, and read back next round. Those reads are the 47MB / 5728
// `tool/result` records behind the compaction storms (explore P0′-1).
//
// Advice without a number did not work, so the tail now quotes the measured
// state. This suite pins the renderer (pure) and its edges:
//   - nothing to say → null (the tail stays byte-identical to before);
//   - a small directory still reports (1 KB floor, never "0.0 MB");
//   - the ownership count appears only when it exists;
//   - the line names the budget cost, which is the part the post can act on.
//
// Run: node --test scripts/test-fleet-workspace-hygiene.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { renderWorkspaceHygiene } = await import("../server/fleet-context.js");

test("空/未知工作区不产生任何一行（尾段逐字节不变）", () => {
  assert.equal(renderWorkspaceHygiene(null), null);
  assert.equal(renderWorkspaceHygiene(undefined), null);
  assert.equal(renderWorkspaceHygiene({ files: 0, bytes: 0, ownFiles: 0 }), null);
  assert.equal(renderWorkspaceHygiene({ files: Number.NaN }), null, "a broken provider must not inject a half-sentence");
});

test("小型工作区用 KB，不足 1KB 也报 1KB（不出现 0.0）", () => {
  const tiny = renderWorkspaceHygiene({ files: 3, bytes: 200, ownFiles: 0 });
  assert.match(tiny, /3 个文件/);
  assert.match(tiny, /1 KB/);
  assert.ok(!tiny.includes("0.0"), "never a fake zero size");
});

test("大型工作区用 MB 并带一位小数", () => {
  const big = renderWorkspaceHygiene({ files: 358, bytes: 26 * 1024 * 1024, ownFiles: 341 });
  assert.match(big, /358 个文件/);
  assert.match(big, /26\.0 MB/);
  assert.match(big, /你自己的往轮文件 341 个/);
});

test("没有自己的往轮文件时不说「0 个」", () => {
  const out = renderWorkspaceHygiene({ files: 5, bytes: 4096, ownFiles: 0 });
  assert.ok(!/你自己的往轮文件/.test(out), "an absent count is absent, not zero");
});

test("这一行说清代价：重复 + 过期 + 直接扣本轮预算", () => {
  const out = renderWorkspaceHygiene({ files: 12, bytes: 8192, ownFiles: 9 });
  assert.match(out, /平台已保存你的往轮/);
  assert.match(out, /重复/);
  assert.match(out, /过期副本/);
  assert.match(out, /上下文预算/, "the cost must be the one the post can weigh");
});

// ── 接线：这一行真的会出现在巡逻尾段里，且无 provider 时逐字节不变 ──────────
const { buildFleetContext } = await import("../server/fleet-context.js");

const fakeDb = () => ({
  getFleet: () => ({ id: "f1", name: "卫生舰", state: "active", orchestration: null }),
  getMember: () => ({ id: "m1", title: "监视位", targetKind: "persona", targetId: "p1", parentId: null, kpiSlots: [] }),
  listMembers: () => [{ id: "m1", title: "监视位", parentId: null, kpiSlots: [] }],
  latestReports: () => new Map(),
  previousReport: () => null,
  listReports: () => [],
  listTurnEvents: () => [],
});

const deps = (extra = {}) => ({ db: fakeDb(), deriveStatuses: () => new Map(), ...extra });

test("接线：有 provider 时尾段带工作区现状，无 provider 时不带", async () => {
  const withStat = await buildFleetContext(
    { fleetId: "f1", memberId: "m1" },
    {},
    deps({ workspaceHygiene: () => ({ files: 358, bytes: 26 * 1024 * 1024, ownFiles: 341 }) }),
  );
  assert.match(withStat, /工作区现状：已累积 358 个文件/);
  assert.match(withStat, /你自己的往轮文件 341 个/);
  assert.match(withStat, /巡逻纪律/, "it rides the discipline tail, not a new segment");

  const without = await buildFleetContext({ fleetId: "f1", memberId: "m1" }, {}, deps());
  assert.ok(!without.includes("工作区现状"), "no provider → the tail is exactly as before");

  // A provider that reports an empty directory must not add the line either.
  const empty = await buildFleetContext(
    { fleetId: "f1", memberId: "m1" },
    {},
    deps({ workspaceHygiene: () => ({ files: 0, bytes: 0, ownFiles: 0 }) }),
  );
  assert.ok(!empty.includes("工作区现状"));
});

test("接线：edge 回合不带卫生行（边回合没有纪律尾段）", async () => {
  const edge = await buildFleetContext(
    { fleetId: "f1", memberId: "m1" },
    {},
    deps({ mode: "edge", workspaceHygiene: () => ({ files: 10, bytes: 4096, ownFiles: 9 }) }),
  );
  assert.ok(!edge.includes("工作区现状"));
  assert.ok(!edge.includes("巡逻纪律"));
});
