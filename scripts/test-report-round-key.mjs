#!/usr/bin/env node
// ── 「同一轮」的判据必须是回合起点，不是会话标识 ────────────────────────────
//
// Live 2026-11-13 (openspec: fix-fleet-report-delivery 2.5): 装配岗连点 5 轮，
// 前 3 条报数落库后，turn 1631 的**首条**报数被拒：
//
//   report limit reached (3 per 720 minutes) — next window at 2026-11-13T19:01:21.909Z
//
// 但 `checkFlood` 里明明有 `if (roundReports === 0) return { ok: true }`，线上镜像
// 也确实含这段代码与它的测试。原因是判据键取错：三行 `member_reports.session_id`
// 全是同一个 `platform-<uuid>`（跨轮不变），而回合自己是 `cron-job-*--r<ts>`。
// 于是 `roundReports` 一进窗口就恒等于 3，`=== 0` 的豁免永不成立。
//
// 修法：回合边界取**该回合的起点时刻**（`fleet-runs` 的 handle 上有 `turnId` 与
// `startedAt`，每轮一颗），落在起点之后的报数才算本轮——不依赖任何跨轮不变的键，
// 也不需要改表。
//
// 这条用例在修复前必须是红的（函数还不存在 ⇒ import 失败即红），
// 修好后转绿，并钉住「同轮第二条仍被拒」不被顺手放开。
//
//   node --test scripts/test-report-round-key.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { countRoundReports, checkFlood } = await import(
  path.join(here, "../server/fleet-reports.js")
);

const WINDOW = 720 * 60 * 1000;
const NOW = 1_800_000_000_000;

// 生产现场的形状：三行报数全挂在同一个平台会话名下（跨轮不变）。
function liveShape() {
  return [
    { createdAt: NOW - 10 * 3600_000, sessionId: "platform-7f139688" },
    { createdAt: NOW - 6 * 3600_000, sessionId: "platform-7f139688" },
    { createdAt: NOW - 2 * 3600_000, sessionId: "platform-7f139688" },
  ];
}

test("live shape: 窗口已满 3 条老报数 ⇒ 新回合的 roundReports 必须是 0", () => {
  const inWindow = liveShape();
  const got = countRoundReports({
    inWindow,
    roundStartedAt: NOW - 60_000, // 本回合 1 分钟前才开始
    sessionId: "platform-7f139688", // 与老报数同一会话：这正是旧判据踩的坑
  });
  assert.equal(got, 0, "跨轮不变的会话标识不得把老报数算进本轮");
});

test("live shape + checkFlood：新回合首条必须放行（生产 turn 1631 的反例）", () => {
  const inWindow = liveShape();
  const roundReports = countRoundReports({
    inWindow,
    roundStartedAt: NOW - 60_000,
    sessionId: "platform-7f139688",
  });
  const out = checkFlood({
    countSince: inWindow.length,
    roundReports,
    windowMs: WINDOW,
    now: NOW,
    oldestInWindowAt: inWindow[0].createdAt,
  });
  assert.equal(out.ok, true, "窗口满 + 本轮未报 ⇒ 首条必须落库");
});

test("同轮第二条仍被拒：本轮起点之后已报过一条", () => {
  const inWindow = [...liveShape(), { createdAt: NOW - 30_000, sessionId: "platform-7f139688" }];
  const roundReports = countRoundReports({
    inWindow,
    roundStartedAt: NOW - 60_000,
    sessionId: "platform-7f139688",
  });
  assert.equal(roundReports, 1, "起点之后的报数属于本轮");
  const out = checkFlood({
    countSince: inWindow.length,
    roundReports,
    windowMs: WINDOW,
    now: NOW,
    oldestInWindowAt: inWindow[0].createdAt,
  });
  assert.equal(out.ok, false, "本轮已报过，第二条仍受 FLOOD_MAX_PER_WINDOW 约束");
});

test("没有回合起点时退回会话判据（不得凭空放行）", () => {
  const inWindow = liveShape();
  const got = countRoundReports({ inWindow, roundStartedAt: null, sessionId: "platform-7f139688" });
  assert.equal(got, 3, "无回合边界可依据时，仍按会话计数，不能退化成无限制");
});
