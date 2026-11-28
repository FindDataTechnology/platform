#!/usr/bin/env node
// ── 验收报告 ────────────────────────────────────────────────────────────────
//
// 这份报告是交付时给客户看的，所以要能被当作证据：
//   - 同一份数据、同一时刻生成两次，数值必须完全一致（幂等）
//   - 零数据必须判未通过（接口 200 不算通过）
//   - 分母为 0 时给 null 而不是 0%，否则会被读成"没人同意"
//   - 滞后曲线用每日条数，不用平均值（平均值会把完整断流摊薄成温和数字）
//
//   node --test scripts/test-archive-acceptance.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { buildAcceptanceReport, acceptanceLine, dailyVolume, ZERO_DATA_WINDOW_HOURS } = await import(
  "../server/archive/acceptance.js"
);

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

function addConv(db, { id, agreeState = "agree", name = "" }) {
  store.upsertConversation(db, {
    conversationId: id,
    kind: "single",
    name,
    agreeState,
    agreeAt: agreeState === "agree" ? NOW - DAY : 0,
  });
}

function addMsg(db, { conv, id, at, origin = "peer" }) {
  store.insertMessage(db, {
    id: `${conv}:${id}`,
    conversationId: conv,
    msgId: id,
    sentAt: at,
    origin,
    msgType: "text",
    text: `msg-${id}`,
  });
}

function seeded() {
  const db = freshDb();
  addConv(db, { id: "c1" });
  addConv(db, { id: "c2", agreeState: "disagree" });
  addMsg(db, { conv: "c1", id: "m1", at: NOW - 2 * HOUR });
  addMsg(db, { conv: "c1", id: "m2", at: NOW - HOUR });
  addMsg(db, { conv: "c2", id: "m3", at: NOW - 3 * HOUR });
  store.refreshConversationStats(db, "c1");
  store.refreshConversationStats(db, "c2");
  store.writeCursor(db, { seq: 3, lastCheckedAt: NOW, lastMessageAt: NOW - HOUR, lastSuccessAt: NOW - HOUR });
  return db;
}

test("四个实数齐全：席位 / 会话 / 同意占比 / 滞后曲线", () => {
  const db = seeded();
  const r = buildAcceptanceReport(db, { purchasedSeats: 10, effectiveSeats: 7, now: NOW });
  assert.equal(r.seats.purchased, 10);
  assert.equal(r.seats.effective, 7);
  assert.equal(r.seats.gap, 3);
  assert.equal(r.sessions.total, 2);
  assert.equal(r.sessions.withMessages, 2);
  assert.equal(r.sessions.consented, 1);
  assert.equal(r.sessions.disagreed, 1);
  assert.equal(r.sessions.consentRatio, 0.5);
  assert.equal(r.messages.total, 3);
  assert.equal(r.messages.last24h, 3);
  assert.equal(r.lag.level, "ok");
  assert.equal(r.lag.series.length, 14, "默认 14 天曲线");
  assert.equal(r.lag.series.at(-1).count, 3, "今天的桶里应有 3 条");
  assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict.reasons));
});

test("幂等：同一份数据同一时刻两次生成完全一致", () => {
  const db = seeded();
  const a = buildAcceptanceReport(db, { purchasedSeats: 10, effectiveSeats: 7, now: NOW });
  const b = buildAcceptanceReport(db, { purchasedSeats: 10, effectiveSeats: 7, now: NOW });
  assert.deepEqual(a, b, "验收报告必须可复现，否则不能当证据");
});

test("零数据判未通过（接口通不是通过）", () => {
  const db = freshDb();
  const r = buildAcceptanceReport(db, { purchasedSeats: 5, effectiveSeats: 5, now: NOW });
  assert.equal(r.verdict.ok, false);
  assert.ok(r.verdict.reasons.some((x) => x.startsWith("no_messages_at_all")), JSON.stringify(r.verdict.reasons));
});

test("有历史但 24 小时零入库：判未通过并指出要区分两种原因", () => {
  const db = freshDb();
  addConv(db, { id: "c1" });
  addMsg(db, { conv: "c1", id: "m1", at: NOW - 3 * DAY });
  store.refreshConversationStats(db, "c1");
  store.writeCursor(db, { seq: 1, lastCheckedAt: NOW, lastMessageAt: NOW - 3 * DAY, lastSuccessAt: NOW - 3 * DAY });

  const r = buildAcceptanceReport(db, { purchasedSeats: 5, effectiveSeats: 5, now: NOW });
  assert.equal(r.verdict.ok, false);
  assert.ok(
    r.verdict.reasons.some((x) => x.startsWith("zero_ingest_24h")),
    JSON.stringify(r.verdict.reasons),
  );
  assert.equal(ZERO_DATA_WINDOW_HOURS, 24);
});

test("未提供席位数：不能假装核对过覆盖率", () => {
  const db = seeded();
  const r = buildAcceptanceReport(db, { now: NOW });
  assert.equal(r.verdict.ok, false);
  assert.ok(r.verdict.reasons.some((x) => x.startsWith("seat_numbers_missing")));
});

test("滞后超过 5 天：判未通过并且缺口是不可补偿的", () => {
  const db = freshDb();
  addConv(db, { id: "c1" });
  addMsg(db, { conv: "c1", id: "m1", at: NOW - 6 * DAY });
  store.refreshConversationStats(db, "c1");
  store.writeCursor(db, { seq: 1, lastCheckedAt: NOW, lastMessageAt: NOW - 6 * DAY, lastSuccessAt: NOW - 6 * DAY });
  const r = buildAcceptanceReport(db, { purchasedSeats: 5, effectiveSeats: 5, now: NOW });
  assert.equal(r.lag.level, "lost");
  assert.equal(r.verdict.ok, false);
  assert.ok(r.verdict.reasons.some((x) => x.startsWith("history_unrecoverable")));
});

test("没有会话时同意占比为 null，不是 0（0% 会被读成没人同意）", () => {
  const db = freshDb();
  const r = buildAcceptanceReport(db, { purchasedSeats: 1, effectiveSeats: 1, now: NOW });
  assert.equal(r.sessions.consentRatio, null);
  assert.ok(acceptanceLine(r).includes("同意占比 无会话"), acceptanceLine(r));
});

test("滞后曲线按天分桶，不是平均值", () => {
  const db = freshDb();
  addConv(db, { id: "c1" });
  addMsg(db, { conv: "c1", id: "a", at: NOW - 2 * DAY });
  addMsg(db, { conv: "c1", id: "b", at: NOW - 2 * DAY + HOUR });
  addMsg(db, { conv: "c1", id: "c", at: NOW - HOUR });
  const series = dailyVolume(db, { now: NOW, days: 4 });
  assert.equal(series.length, 4);
  assert.equal(series.at(-1).count, 1, "今天 1 条");
  assert.equal(series.at(-2).count, 0, "昨天 0 条（断了一天，曲线要看得见）");
  assert.equal(series.at(-3).count, 2, "前天 2 条");
});

test("报告自带口径：不宣称全量 + 明确以入库数据为准", () => {
  const r = buildAcceptanceReport(seeded(), { purchasedSeats: 1, effectiveSeats: 1, now: NOW });
  assert.equal(r.claimsFullCoverage, false);
  assert.ok(r.note.includes("5 天"));
  assert.ok(r.note.includes("不作为通过依据"));
  assert.equal(r.schemaVersion, 1);
});

test("一行摘要含判定与四个实数", () => {
  const r = buildAcceptanceReport(seeded(), { purchasedSeats: 10, effectiveSeats: 7, now: NOW });
  const line = acceptanceLine(r);
  assert.ok(line.includes("验收通过"), line);
  assert.ok(line.includes("会话 2/2"), line);
  assert.ok(line.includes("同意 50.0%"), line);
  assert.ok(line.includes("滞后 ok"), line);
});

test("CLI：未通过时退出码 1，--out 落文件", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");

  const dir = mkdtempSync(pathMod.join(tmpdir(), "acc-cli-"));
  try {
    const cli = pathMod.resolve(import.meta.dirname, "..", "server", "archive", "cli.mjs");
    const outFile = pathMod.join(dir, "report.json");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [cli, "acceptance", "--out", outFile], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ARCHIVE_DB: pathMod.join(dir, "a.db") },
      });
    } catch (err) {
      status = err.status;
      stdout = String(err.stdout || "");
    }
    assert.equal(status, 1, "零数据必须非 0 退出");
    assert.ok(existsSync(outFile), "--out 应写文件");
    const written = JSON.parse(readFileSync(outFile, "utf8"));
    const echoed = JSON.parse(stdout);
    assert.deepEqual(written, echoed, "文件与 stdout 必须一致");
    assert.equal(written.verdict.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
