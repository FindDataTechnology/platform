// 胜任力候选（establish-agent-role-and-fitness-plane 6.1 / 6.2 / 6.3）。
//
// 这条链最容易出的三件事，每件都写成断言：
//   1. 候选**自动生效**（时间到了就 active）——6.3 明令禁止
//   2. 生效**没有验收者**——自己验自己
//   3. 被质疑 = 不可见——6.2 要求「读面提示」，候选页照样可读
//
// Run: node --test scripts/test-competence-candidates.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "comp-"));
process.env.PLATFORM_DATA_DIR = tmp;
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

const fresh = () => {
  const db = createFleetDatabase({ file: path.join(tmp, `c-${Math.random().toString(36).slice(2)}.db`) });
  db.createFleet({ id: "f1", name: "胜任舰", ownerEmail: "o@test" });
  return db;
};

test("新建候选 ⇒ state=candidate（不会因为写入就生效）", () => {
  const db = fresh();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/notes/abc.md", evidence: { turns: 3 } });
  assert.equal(c.state, "candidate");
  assert.equal(c.acceptedBy, null);
  db.close();
});

test("同一 pageRef 重复登记 ⇒ 幂等（不产生第二行）", () => {
  const db = fresh();
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/notes/x.md" });
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/notes/x.md", evidence: { turns: 5 } });
  const rows = db.listCompetenceCandidates("f1");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].evidence, { turns: 5 });
  db.close();
});

test("生效必须带验收者：没有 acceptedBy ⇒ 拒绝，状态不变（6.3）", () => {
  const db = fresh();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/a.md" });
  const r = db.acceptCompetenceCandidate(c.id, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, "accepted_by_required");
  assert.equal(db.getCompetenceCandidate(c.id).state, "candidate", "被拒的生效不得改动状态");
  db.close();
});

test("带验收者 ⇒ active，且记下是谁、何时", () => {
  const db = fresh();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/a.md" });
  const r = db.acceptCompetenceCandidate(c.id, { acceptedBy: "meta-grader" });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.state, "active");
  assert.equal(r.candidate.acceptedBy, "meta-grader");
  assert.ok(r.candidate.acceptedAt > 0);
  db.close();
});

test("验收者是空白字符串也算没给（不能拿空格绕过）", () => {
  const db = fresh();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/a.md" });
  assert.equal(db.acceptCompetenceCandidate(c.id, { acceptedBy: "   " }).ok, false);
  db.close();
});

test("被质疑 ⇒ state=disputed 且带质疑者与依据（6.2 的读面提示）", () => {
  const db = fresh();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/a.md" });
  db.acceptCompetenceCandidate(c.id, { acceptedBy: "owner" });
  const d = db.disputeCompetenceCandidate(c.id, { by: "meta-grader", basis: "样本只有 2 轮" });
  assert.equal(d.state, "disputed");
  assert.equal(d.disputedBy, "meta-grader");
  assert.equal(d.disputeBasis, "样本只有 2 轮");
  // 仍可被列出（不是删除，不是隐藏）
  assert.equal(db.listCompetenceCandidates("f1").length, 1);
  db.close();
});

test("按 state / memberId 过滤（读面要能只拿候选、只拿某岗）", () => {
  const db = fresh();
  const a = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "p/a.md" });
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m2", pageRef: "p/b.md" });
  db.acceptCompetenceCandidate(a.id, { acceptedBy: "owner" });
  assert.equal(db.listCompetenceCandidates("f1", { state: "candidate" }).length, 1);
  assert.equal(db.listCompetenceCandidates("f1", { memberId: "m2" }).length, 1);
  assert.equal(db.listCompetenceCandidates("f1").length, 2);
  db.close();
});

test("不存在的候选：生效/质疑都返回 null 或错误，不抛", () => {
  const db = fresh();
  const r = db.acceptCompetenceCandidate("nope", { acceptedBy: "x" });
  assert.deepEqual(r, { ok: false, error: "not_found" });
  assert.equal(db.disputeCompetenceCandidate("nope", { by: "x" }), null);
  db.close();
});

test("6.2 读面提示：把「正在被质疑」渲染成一段（无则 null，不是空段）", async () => {
  const { renderCompetenceDisputes } = await import("../server/cron-runner.js");
  assert.equal(renderCompetenceDisputes([]), null, "没有质疑项 ⇒ null");
  assert.equal(renderCompetenceDisputes([{ state: "candidate" }]), null, "非 disputed 不提示");
  const text = renderCompetenceDisputes([
    { state: "disputed", pageRef: "p/a.md", disputedBy: "mg", disputeBasis: "样本 2 轮" },
    { state: "disputed", pageRef: "p/b.md" },
  ]);
  assert.ok(text.includes("正在被质疑的结论"));
  assert.ok(text.includes("p/a.md") && text.includes("mg") && text.includes("样本 2 轮"));
  assert.ok(text.includes("质疑者未记录"), "缺失质疑者也要如实说，不编一个");
  assert.ok(text.includes("仍可读到"), "候选页不因被质疑而消失");
});

test("6.2 提示最多列 5 条，其余如实计数（不静默截断）", async () => {
  const { renderCompetenceDisputes } = await import("../server/cron-runner.js");
  const rows = Array.from({ length: 8 }, (_, i) => ({ state: "disputed", pageRef: `p/${i}.md` }));
  assert.ok(renderCompetenceDisputes(rows).includes("另有 3 条"));
});
