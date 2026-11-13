// Report contract (enforce-report-contract).
//
// The fleet's own template says it in words: 34 of 35 posts carry 「收尾必
// report_status」. Production, 24h: 516 turns, 119 reports (0.23/turn) — and
// settlement recorded `ok` for rounds that delivered nothing.
//
// WHERE THE CONTRACT COMES FROM (this cost a production check): the persona text
// does NOT live in the platform catalog — a live cell's `getChatAgentEntries()`
// returns 0 and every preset resolves to null there. The text the runtime runs
// is composed into presets.patch.yml by writePresetsPatchSync; so the verdict is
// published at composition time into the same process that settles turns.
//
// Run: node --test scripts/test-report-contract.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { declaresReportContract, isMissingReport, reportContractFor, publishReportContracts, clearReportContracts } =
  await import("../server/report-contract.js");

// `publishReportContracts` fills a process-global table; leaving it populated
// makes this file order-dependent for anything appended later (and it was the
// reason the import below tripped the unused-variable gate: the clear was
// intended, just never wired). Clearing on exit is the point of the export.
test.after(() => clearReportContracts());

test("人设声明识别：真实模板的两种措辞都命中", () => {
  assert.equal(declaresReportContract("【输出契约】收尾必 report_status（槽位 items_found/top_story）"), true);
  assert.equal(declaresReportContract("每轮结束必须调用 report_status 交结论"), true);
  assert.equal(declaresReportContract("你是柏讯内容舰队的内容岗。只在被巡线岗委派时起回合。"), false);
  assert.equal(declaresReportContract(""), false);
  assert.equal(declaresReportContract(null), false);
});

test("三态判据：只有成功回合才可能违约", () => {
  const req = "required";
  assert.equal(isMissingReport({ status: "ok", reportContract: req, reported: false }), true);
  assert.equal(isMissingReport({ status: "ok", reportContract: req, reported: true }), false);
  assert.equal(isMissingReport({ status: "failed", reportContract: req, reported: false }), false, "失败回合没机会交");
  assert.equal(isMissingReport({ status: "interrupted", reportContract: req, reported: false }), false);
  assert.equal(isMissingReport({ status: "skipped", reportContract: req, reported: false }), false);
  assert.equal(isMissingReport({ status: "ok", reportContract: null, reported: false }), false, "没声明契约的岗位不判");
});

test("契约表由合成期发布，未知名不判（degrade open）", () => {
  const published = publishReportContracts([
    { id: "xb-policy-scout", persona: "【输出契约】收尾必 report_status" },
    { id: "wire-fleet-content", persona: "只在被巡线岗委派时起回合" },
  ]);
  assert.equal(published["xb-policy-scout"], "required");
  assert.equal(published["wire-fleet-content"], null);
  assert.equal(reportContractFor("xb-policy-scout"), "required", "发布会话里能读到");
  assert.equal(reportContractFor("wire-fleet-content"), null);
  assert.equal(reportContractFor("never-heard-of-it"), null, "未知 preset 一律不判");
  assert.equal(reportContractFor(null), null);
});

test("结算：声明必交而未交 → ok + detail.missingReport（status 不动）", async () => {
  const { shapeTurnOutcome } = await import("../server/fleet-events.js");
  const shaped = shapeTurnOutcome(
    { ok: true, usage: { input: 5000, output: 900 }, text: "扫完了，无命中", toolBlocks: [{ kind: "tool", name: "search_info", result: "0" }], reported: false },
    { reportContract: "required" },
  );
  assert.equal(shaped.status, "ok", "回合确实跑完了：status 不动，通过率不变");
  assert.equal(shaped.detail?.missingReport, true);
  assert.equal(shaped.detail?.reportContract, "required");

  const delivered = shapeTurnOutcome(
    { ok: true, usage: { input: 5000, output: 900 }, text: "结论", toolBlocks: [{ kind: "tool", name: "mcp__fleet__report_status", result: "ok" }], reported: true },
    { reportContract: "required" },
  );
  assert.equal(delivered.detail?.missingReport, undefined, "交了就不标");

  const failed = shapeTurnOutcome({ ok: false, error: "503" }, { reportContract: "required" });
  assert.equal(failed.detail?.missingReport, undefined, "失败回合没机会交");
});

test("一个回合只被一条规则判：桩回合不再叠 missingReport", async () => {
  const { shapeTurnOutcome } = await import("../server/fleet-events.js");
  // 生产实测组合（2026-11-10 05:43）：out=128、无文本无工具无报数、岗位声明必交。
  const shaped = shapeTurnOutcome(
    { ok: true, usage: { input: 900, output: 128 }, text: "", toolBlocks: [], reported: false },
    { reportContract: "required" },
  );
  assert.equal(shaped.status, "interrupted", "先按桩判");
  assert.equal(shaped.detail?.stubTurn, true);
  assert.equal(shaped.detail?.missingReport, undefined, "已判桩就不再叠交付违约——一条规则判一次");

  // 而同岗位、非桩、未交报的回合仍然要被判违约。
  const ranButSilent = shapeTurnOutcome(
    { ok: true, usage: { input: 9000, output: 800 }, text: "扫完了", toolBlocks: [{ kind: "tool", name: "search", result: "0" }], reported: false },
    { reportContract: "required" },
  );
  assert.equal(ranButSilent.status, "ok");
  assert.equal(ranButSilent.detail?.missingReport, true);
});

test("读面：交付率与通过率并列，且半截/桩不混入", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
  const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
  const db = createFleetDatabase({ file: path.join(dir, "d.db") });
  const fleet = db.createFleet({ id: "f_del", name: "交付舰", ownerEmail: "o@t" });
  db.createMember({ id: "m1", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p1", parentId: null, kpiSlots: [], cadence: null });
  const now = Date.now();
  const ev = (over) => db.appendTurnEvent({ fleetId: fleet.id, memberId: "m1", source: "cron", startedAt: now, endedAt: now, metering: {}, ...over });
  ev({ status: "ok", detail: null });                                  // 交了
  ev({ status: "ok", detail: { missingReport: true } });               // 跑了没交
  ev({ status: "ok", detail: { stubTurn: true } });                    // 桩（status 本就不是 ok，这里模拟残留）
  ev({ status: "failed", detail: null });                              // 失败

  const p = db.spendProjection(fleet.id);
  const t = p.allTime;
  assert.equal(t.eventTurns, 4, "回合事件数（与交付率同源）");
  assert.equal(t.okTurns, 3, "ok 计数不受判据影响（通过率语义不变）");
  assert.equal(t.missingReportTurns, 1);
  assert.equal(t.deliveredOk, 2, "3 个 ok 里 1 个没交 → 2 个交付");
  assert.ok(Math.abs(t.deliveryRate - 2 / 4) < 1e-9, "交付率分母是全部回合，可与通过率并列看");
  assert.match(t.deliveryBasis, /since the missingReport flag/, "读数必须自报起算口径");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
