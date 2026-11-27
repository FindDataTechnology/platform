// 角色版本 + 定向指导（agent-as-employee-model 1.4 / 2.5）。
//
// Run: node --test scripts/test-role-guidance.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

function freshRole() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-guidance-"));
  const db = createFleetDatabase({ file: path.join(dir, "fleets.db") });
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", organs: { charter: "v0" } });
  return db;
}
const human = { kind: "human", id: "owner@x" };
const agentA = { kind: "agent", id: "agent-a" };
const patch = (over = {}) => ({ fleetId: "f1", memberId: "m1", baseVersion: 0, organ: "charter", content: "new", author: agentA, reason: "tighten", ...over });

test("缺发起人的补丁被拒，点名字段，版本不变", () => {
  const db = freshRole();
  const r = db.submitGuidancePatch(patch({ author: undefined }));
  assert.ok(r.error);
  assert.ok(r.missing.includes("author"));
  assert.equal(db.currentRoleVersion("f1", "m1"), 0);
});

test("agent 不能自批", () => {
  const db = freshRole();
  const { patch: p } = db.submitGuidancePatch(patch());
  const r = db.mergeGuidancePatch(p.id, { by: agentA });
  assert.equal(r.code, "self-approval");
  assert.equal(db.getGuidancePatch(p.id).state, "pending");
});

test("合入产生新版本，source=guidance，可追到补丁与发起人", () => {
  const db = freshRole();
  const { patch: p } = db.submitGuidancePatch(patch());
  const r = db.mergeGuidancePatch(p.id, { by: human });
  assert.equal(r.version, 1);
  assert.equal(db.getRoleState("f1", "m1").organs.charter, "new");
  const [v] = db.listRoleVersions("f1", "m1", { source: "guidance" });
  assert.equal(v.patchId, p.id);
  assert.equal(v.actor, "human:owner@x");
});

test("期间角色自我进化 ⇒ 基版本过期，拒合", () => {
  const db = freshRole();
  const { patch: p } = db.submitGuidancePatch(patch());
  db.commitRoleVersion({ fleetId: "f1", memberId: "m1", organs: { charter: "self-learned" }, source: "self" });
  const r = db.mergeGuidancePatch(p.id, { by: human });
  assert.equal(r.code, "stale-base");
  assert.equal(db.getRoleState("f1", "m1").organs.charter, "self-learned");
});

test("版本史按来源筛看", () => {
  const db = freshRole();
  db.commitRoleVersion({ fleetId: "f1", memberId: "m1", organs: { charter: "a" }, source: "self" });
  const { patch: p } = db.submitGuidancePatch(patch({ baseVersion: 1 }));
  db.mergeGuidancePatch(p.id, { by: human });
  assert.deepEqual(db.listRoleVersions("f1", "m1").map((v) => v.source), ["self", "guidance"]);
  assert.equal(db.listRoleVersions("f1", "m1", { source: "self" }).length, 1);
});

test("驳回需理由且终态", () => {
  const db = freshRole();
  const { patch: p } = db.submitGuidancePatch(patch());
  assert.ok(db.rejectGuidancePatch(p.id, { by: human }).error);
  assert.ok(db.rejectGuidancePatch(p.id, { by: human, reason: "off-charter" }).ok);
  assert.ok(db.mergeGuidancePatch(p.id, { by: human }).error);
});

test("克隆角色未授权被拒且不产生新角色", () => {
  const db = freshRole();
  const r = db.cloneRole({ from: { fleetId: "f1", memberId: "m1" }, to: { fleetId: "f1", memberId: "m2" } });
  assert.ok(r.missing.includes("authorizedBy"));
  assert.equal(db.getRoleState("f1", "m2"), null);
});

test("克隆角色带器官与已生效胜任力，如实标记领域记忆待复制", () => {
  const db = freshRole();
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "pg-1", evidence: {}, state: "active" });
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "pg-2", evidence: {}, state: "candidate" });
  const r = db.cloneRole({ from: { fleetId: "f1", memberId: "m1" }, to: { fleetId: "f2", memberId: "m1" }, authorizedBy: "owner@x" });
  assert.equal(r.competence, 1);
  assert.equal(r.domainMemory, "pending-memory-service-copy");
  assert.equal(db.getRoleState("f2", "m1").organs.charter, "v0");
  assert.deepEqual(db.listCompetenceCandidates("f2", { memberId: "m1" }).map((c) => c.pageRef), ["pg-1"]);
});

test("晋升载荷只含声明、已生效胜任力与出处，不含任何记忆条目", () => {
  const db = freshRole();
  db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "pg-1", evidence: { snippet: "secret domain fact" }, state: "active" });
  const p = db.promotionPayload("f1", "m1", { actor: "owner@x" });
  assert.deepEqual(p.competence, ["pg-1"]);
  assert.equal(p.provenance.role, "f1/m1");
  assert.ok(!JSON.stringify(p).includes("secret domain fact"));
});

test("采纳胜任力 ⇒ 进版本史且来源为 self；无角色行时不造版本", () => {
  const db = freshRole();
  const c = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "m1", pageRef: "pg-9", evidence: {}, state: "candidate" });
  const r = db.acceptCompetenceCandidate(c.id, { acceptedBy: "owner@x" });
  assert.equal(r.version, 1);
  const [v] = db.listRoleVersions("f1", "m1", { source: "self" });
  assert.equal(v.version, 1);
  assert.equal(v.actor, "owner@x");
  const c2 = db.upsertCompetenceCandidate({ fleetId: "f1", memberId: "ghost", pageRef: "pg-1", evidence: {}, state: "candidate" });
  const r2 = db.acceptCompetenceCandidate(c2.id, { acceptedBy: "owner@x" });
  assert.equal(r2.ok, true);
  assert.equal(r2.version, null);
});

test("成员无角色行时首次提案以空器官建版本 0；不存在的成员仍拒", () => {
  const db = freshRole();
  db.createFleet({ id: "f9", name: "f", ownerEmail: "o@x" });
  db.createMember({ id: "m9", fleetId: "f9", title: "t", targetKind: "tool", targetId: "s::t" });
  const r = db.submitGuidancePatch({ fleetId: "f9", memberId: "m9", baseVersion: 0, organ: "charter", content: "c", author: human, reason: "r" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(db.currentRoleVersion("f9", "m9"), 0);
  assert.deepEqual(db.getRoleState("f9", "m9").organs, {});
  assert.ok(db.submitGuidancePatch({ fleetId: "f9", memberId: "nope", baseVersion: 0, organ: "charter", content: "c", author: human, reason: "r" }).error);
});

test("晋升清单：逐岗带器官与已生效胜任力，已删岗不计入", () => {
  const db = freshRole();
  db.createFleet({ id: "f7", name: "f", ownerEmail: "o@x" });
  db.createMember({ id: "a1", fleetId: "f7", title: "a", targetKind: "tool", targetId: "s::t" });
  db.createMember({ id: "a2", fleetId: "f7", title: "b", targetKind: "tool", targetId: "s::t" });
  db.upsertRoleState({ fleetId: "f7", memberId: "a1", organs: { charter: "c1" } });
  db.upsertRoleState({ fleetId: "f7", memberId: "a2", organs: { charter: "c2" } });
  db.upsertCompetenceCandidate({ fleetId: "f7", memberId: "a1", pageRef: "pg", evidence: {}, state: "active" });
  db.upsertCompetenceCandidate({ fleetId: "f7", memberId: "a1", pageRef: "pg2", evidence: {}, state: "candidate" });
  const roles = db.rolesForPromotion("f7");
  assert.deepEqual(roles.map((r) => r.memberId), ["a1", "a2"]);
  assert.deepEqual(roles[0].competence, ["pg"]);
  assert.equal(roles[0].organs.charter, "c1");
});
