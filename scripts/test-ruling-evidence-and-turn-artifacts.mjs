// ── 拍板判定引用 + 回合产出引用 验收闸 ─────────────────────────────────────
// (openspec bind-decision-verdict-ref-and-turn-artifacts §6 验收闸)
//
// 每条闸都构造得出「缺陷时会判红」的输入，并带一条负例自证（criterion-must-fire-
// on-real-data 约束）：
//   6.1 拍板回溯：依据评测结论裁为通过 → 读面解析出结论标识与尺子 digest 并可回读；
//   6.2 人裁定：无评测结论的人工裁定 → 记明「无判定引用」，不读成失败；
//   6.3 一轮多产物：两份交付物 → 两条引用挂同一 turn_ref 且可独立取到；
//   6.4 零产出：无产出引用 → 读作「无产出引用」，与「取不到」可区分；
//   6.5 旧行零变化：纯文本 ruling_evidence 的存量行读面与改动前逐字节一致。
//
//   node --test scripts/test-ruling-evidence-and-turn-artifacts.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";

const {
  buildRulingEvidence,
  parseRulingEvidence,
  normalizeVerdictRef,
} = await import("../lib/ruling-evidence.js");
const { createTurnClaimStore } = await import("../lib/turn-claim-store.js");
const { turnRefFor } = await import("../lib/turn-claim.js");
const { renderDeputyDigest } = await import("../server/fleet-delegation-digest.js");

// ── 6.1 拍板回溯：结构化判定引用可解析出结论标识 + 尺子 digest ──────────────
test("6.1 拍板回溯：带 verdictRef 的裁决行存可解析 JSON，回读出结论标识与尺子 digest", () => {
  const ref = { verdictRef: "run_42", rulerDigest: "d".repeat(64), outcome: "pass" };
  const raw = buildRulingEvidence({ verdictRef: ref, evidence: "依据评测结论通过" });
  const parsed = parseRulingEvidence(raw);
  assert.equal(parsed.kind, "verdict");
  assert.equal(parsed.verdictRef, "run_42");
  assert.equal(parsed.rulerDigest, "d".repeat(64), "尺子 digest 原样保留，可回读该结论");
  assert.equal(parsed.outcome, "pass");
  assert.equal(parsed.text, "依据评测结论通过");
});

// 负例自证：缺结论标识时整组不成立（不能写成半截身份）。
test("6.1 负例：半截身份（缺结论标识）不被当成结构化判定引用", () => {
  assert.equal(normalizeVerdictRef({ rulerDigest: "d".repeat(64), outcome: "pass" }), null);
  // 没有 verdictRef ⇒ 退回文本（此处 evidence 为空 ⇒ null），不伪造一条判定。
  assert.equal(buildRulingEvidence({ verdictRef: { rulerDigest: "x" }, evidence: null }), null);
});

// ── 6.2 人裁定：无判定引用，不读成失败 ─────────────────────────────────────
test("6.2 人裁定：无评测结论的人工裁定记明「无判定引用」，且与「判定失败」形状不同", () => {
  const raw = buildRulingEvidence({ verdictRef: null, evidence: "按经验直接批准", noVerdictMarker: true });
  const parsed = parseRulingEvidence(raw);
  assert.equal(parsed.kind, "no-verdict-ref");
  assert.equal(parsed.verdictRef, null, "显式 null，不是缺键");
  assert.equal(parsed.text, "按经验直接批准");
  // 判定失败会是一个 verdict 形状带 outcome!=pass；这里 kind 明确不同。
  assert.notEqual(parsed.kind, "verdict");
});

// ── 6.5 旧行零变化：纯文本 ruling_evidence 逐字节一致 ──────────────────────
test("6.5 旧行零变化：纯文本存量行的 text 与原文逐字节一致，且不读成「无依据」", () => {
  const original = "主人 2026-10 判例：一律附图（含细节，  多个空格  保留）";
  const parsed = parseRulingEvidence(original);
  assert.equal(parsed.kind, "text");
  assert.equal(parsed.text, original, "逐字节，包括内部空格");
  assert.equal(parsed.verdictRef, null);
  // 读成「文本依据」而非「无依据」：kind 是 'text'，不是 null / no-verdict-ref。
  assert.notEqual(parsed.kind, "no-verdict-ref");
  assert.notEqual(parsed.kind, null);
});

// 一个恰好长得像 JSON 的纯文本不该被猜成结构化。
test("6.5 负例：长得像 JSON 但没有本模块 kind 标记的纯文本仍读作 text", () => {
  const sneaky = JSON.stringify({ note: "看起来像结构，但不是我们的形状" });
  const parsed = parseRulingEvidence(sneaky);
  assert.equal(parsed.kind, "text");
  assert.equal(parsed.text, sneaky);
});

// ── 6.1/6.2 在 delegation digest 上的读面（§1.3） ──────────────────────────
test("§1.3 digest：结构化行输出结论标识，纯文本行输出与改动前一致", () => {
  const RESOLVED_AT = 1_000_000; // 固定的过去时刻，避免与 `now` 的求值先后竞态
  const db = {
    listDecisions: () => [
      {
        id: "d_v", severity: "normal", category: "routine-ops", question: "依据评测结论的批准",
        resolvedBy: "deputy", resolvedAt: RESOLVED_AT, route: "deputy", state: "approved",
        resolution: { kind: "approve", choice: "y" },
        options: [{ value: "y", label: "批准" }],
        rulingEvidence: buildRulingEvidence({ verdictRef: { verdictRef: "run_7", rulerDigest: "abc123def456ghi", outcome: "pass" }, evidence: null }),
        rulingEvidenceParsed: parseRulingEvidence(buildRulingEvidence({ verdictRef: { verdictRef: "run_7", rulerDigest: "abc123def456ghi", outcome: "pass" }, evidence: null })),
      },
      {
        id: "d_t", severity: "normal", category: "routine-ops", question: "凭判例的批准",
        resolvedBy: "deputy", resolvedAt: RESOLVED_AT, route: "deputy", state: "approved",
        resolution: { kind: "approve", choice: "y" },
        options: [{ value: "y", label: "批准" }],
        rulingEvidence: "主人 10 月判例：一律附图",
        rulingEvidenceParsed: parseRulingEvidence("主人 10 月判例：一律附图"),
      },
    ],
    listMembers: () => [],
    getFleetMandatePolicy: () => null,
    outboundLevelSamples: () => ({}),
  };
  const fleet = { id: "f", name: "测试舰", delegationPolicy: { deputyMemberId: null } };
  const page = renderDeputyDigest({ db, fleet, since: 0, now: RESOLVED_AT + 1 });
  assert.ok(page);
  assert.match(page, /判定 run_7/, "结构化行输出结论标识");
  assert.match(page, /abc123def456/, "并带尺子 digest 前缀");
  // 纯文本行仍是原来的「依据: <文本>」形状。
  assert.match(page, /依据: 主人 10 月判例：一律附图/);
});

// ── 6.3 一轮多产物 & 6.4 零产出（claim 上的产出引用读面 §3） ─────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruling-artifacts-"));
const dbFile = path.join(tmp, "fleets.db");

function freshStore() {
  try { fs.rmSync(dbFile, { force: true }); } catch { /* fresh */ }
  const db = new Database(dbFile);
  const store = createTurnClaimStore({ db });
  return { db, store };
}

const REF = turnRefFor({ driver: "platform", source: "cell:aaaabbbbccccdddd", runId: "run_a", turnId: "turn_a" });
const base = (over = {}) => ({
  turnRef: REF, driver: "platform", source: "cell:aaaabbbbccccdddd",
  runId: "run_a", turnId: "turn_a", fleetId: "f", memberId: "m", sessionId: "s", startedAt: 1000, ...over,
});

test("6.3 一轮多产物：两条引用挂同一 turn_ref 且可独立取到", () => {
  const { db, store } = freshStore();
  store.claim(base());
  const out = store.setArtifactRefs(REF, ["res_1 · out/a.png", "res_2 · out/b.xlsx"]);
  assert.equal(out.ok, true);
  const row = store.get(REF);
  assert.equal(row.artifact_refs.length, 2);
  assert.equal(row.artifact_refs[0], "res_1 · out/a.png");
  assert.equal(row.artifact_refs[1], "res_2 · out/b.xlsx");
  db.close();
});

test("6.4 零产出：无产出引用读作「无产出引用」（null），与「取不到这一行」可区分", () => {
  const { db, store } = freshStore();
  store.claim(base());
  // 未写 artifact_refs ⇒ null，是「本轮没有产出引用」。
  assert.equal(store.get(REF).artifact_refs, null, "未记过 = 无产出引用");
  // 取不到的 turn_ref ⇒ get 返回 undefined，是另一回事。
  assert.equal(store.get("platform:cell:ffff:run_x:turn_x"), undefined, "取不到这一行");
  // 显式空集也是「确认零产出」，与 null 同为无产出、但不伪装成「取不到」。
  store.setArtifactRefs(REF, []);
  assert.deepEqual(store.get(REF).artifact_refs, []);
  db.close();
});

// 负例：产出引用写一次，重放不覆盖（与 bench_run_id 同纪律）。
test("§3 负例：产出引用写一次，重放的新值不覆盖先到者", () => {
  const { db, store } = freshStore();
  store.claim(base());
  assert.equal(store.setArtifactRefs(REF, ["first"]).applied, true);
  const again = store.setArtifactRefs(REF, ["second"]);
  assert.equal(again.applied, false, "loser reads the winner");
  assert.deepEqual(store.get(REF).artifact_refs, ["first"]);
  db.close();
});

// ── 6.3/6.4 ledger seam 生产者：artifactRefs 真的挂在该 turn_ref 上（§3.1） ──
test("§3.1 回合收尾 producer：artifactsForTurn 产出的引用经 setArtifactRefs 挂到该 turn_ref", async () => {
  const { db, store } = freshStore();
  store.claim(base());
  // 模拟 ledger end() 的链路：读产出 → 写 claim。断言「有产出 ⇒ 非空且挂在该 ref」。
  const artifactsForTurn = async () => ["res_9 · out/chart.png"];
  const refs = await artifactsForTurn({ sessionId: "s", sinceMs: 1000, toolBlocks: [] });
  store.setArtifactRefs(REF, refs);
  assert.deepEqual(store.get(REF).artifact_refs, ["res_9 · out/chart.png"]);
  // 另一回合（不同 turn_ref）取不到本回合的引用 —— 引用是按回合挂的，不串。
  const otherRef = turnRefFor({ driver: "platform", source: "cell:aaaabbbbccccdddd", runId: "run_a", turnId: "turn_b" });
  assert.equal(store.get(otherRef), undefined);
  db.close();
});

// 负例：无产出的回合，producer 返回空，claim 读作「无产出引用」而非失败。
test("§3.1 负例：无产出回合 producer 返回空，claim 不被写成错误", async () => {
  const { db, store } = freshStore();
  store.claim(base());
  const artifactsForTurn = async () => [];
  const refs = await artifactsForTurn({ sessionId: "s", sinceMs: 1000, toolBlocks: [] });
  const out = store.setArtifactRefs(REF, refs);
  assert.equal(out.ok, true);
  assert.deepEqual(store.get(REF).artifact_refs, [], "确认零产出，不是错误");
  db.close();
});
