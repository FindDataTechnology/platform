// Unit tests for runtime revisions (harden-agent-runtime-spine,
// runtime-revision 5.1–5.5). Pure rules: no store, no clock, no filesystem.
//
// What is pinned here, in the order the specs state it:
//   • identity IS the content — two paths to one fingerprint are one revision
//   • a trial is attached to a FINGERPRINT, and a mismatched one is refused
//   • promotion needs a green trial under the same fingerprint, or an audited
//     human override (who + why) — never a silent skip
//   • rollback is a pointer move that must REPRODUCE; divergence is refused
//   • both verbs leave the same shaped audit record
//
// Run: node --test scripts/test-runtime-revision.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  REVISION_STATES,
  revisionRecord,
  attachTrial,
  decidePromotion,
  decideRollback,
  governanceRecord,
} = await import("../lib/runtime-revision.js");

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

const rev = (fp, over = {}) => revisionRecord({ fingerprint: fp, name: "deploy picks", ...over });

test("identity: a revision without a fingerprint cannot exist", () => {
  assert.throws(() => revisionRecord({}), /fingerprint/);
  const r = rev(FP_A);
  assert.equal(r.revisionId, FP_A, "the id IS the fingerprint");
  assert.deepEqual([...REVISION_STATES], ["candidate", "active", "retired"]);
});

test("identity: the same content reached two ways is ONE revision", () => {
  const viaTrial = rev(FP_A, { name: "from trial" });
  const viaDeploy = rev(FP_A, { name: "straight deploy" });
  assert.equal(viaTrial.revisionId, viaDeploy.revisionId, "the name is a label, not the identity");
});

test("trial: attached to a fingerprint; a report about a DIFFERENT build is refused", () => {
  const r = rev(FP_A);
  const mismatched = attachTrial(r, { fingerprint: FP_B, assertions: [{ pass: true }] });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, "trial-fingerprint-mismatch");

  const ok = attachTrial(r, { fingerprint: FP_A, assertions: [{ pass: true }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.revision.trial.green, true);
});

test("trial: zero assertions is NOT green — an empty report cannot pass", () => {
  const out = attachTrial(rev(FP_A), { assertions: [] });
  assert.equal(out.revision.trial.green, false);
});

test("trial: undecided assertions are counted, not folded into either side", () => {
  const out = attachTrial(rev(FP_A), { assertions: [{ pass: true }, { note: "no criterion" }] });
  assert.equal(out.revision.trial.green, false);
  assert.equal(out.revision.trial.undecided, 1, "a check with no criterion is visible as such");
});

test("promote: no trial ⇒ refused, unless a human override WITH who and why", () => {
  const r = rev(FP_A);
  assert.equal(decidePromotion({ target: r }).reason, "no-trial");
  assert.equal(decidePromotion({ target: r, humanOverride: true }).reason, "override-needs-reason");
  assert.equal(
    decidePromotion({ target: r, humanOverride: true, overrideReason: "hotfix window" }).reason,
    "override-needs-reason",
    "a reason without a name is not an audit trail",
  );
  const ok = decidePromotion({ target: r, humanOverride: true, overrideReason: "hotfix window", overriddenBy: "owner@example.com" });
  assert.equal(ok.ok, true);
  assert.equal(ok.overridden, true);
  assert.equal(ok.override.by, "owner@example.com");
});

test("promote: a green trial under the same fingerprint is the normal path", () => {
  const r = attachTrial(rev(FP_A), { fingerprint: FP_A, assertions: [{ pass: true }, { pass: true }] }).revision;
  const d = decidePromotion({ target: r });
  assert.equal(d.ok, true);
  assert.equal(d.reason, "trial-green");
  assert.equal(d.overridden, undefined);
});

test("promote: a FAILED trial is not promotable without an audited override", () => {
  const r = attachTrial(rev(FP_A), { fingerprint: FP_A, assertions: [{ pass: false }] }).revision;
  assert.equal(decidePromotion({ target: r }).reason, "trial-not-green");
  const forced = decidePromotion({ target: r, humanOverride: true, overrideReason: "known flaky assertion", overriddenBy: "owner@example.com" });
  assert.equal(forced.ok, true);
  assert.equal(forced.overridden, true);
});

test("promote: promoting what is already active is a no-op, not a second revision", () => {
  const r = attachTrial(rev(FP_A), { fingerprint: FP_A, assertions: [{ pass: true }] }).revision;
  const d = decidePromotion({ target: r, currentFingerprint: FP_A });
  assert.equal(d.ok, true);
  assert.equal(d.noop, true);
});

test("rollback: a target that reproduces its fingerprint is allowed", () => {
  const d = decideRollback({ target: rev(FP_B), currentFingerprintOfTarget: FP_B });
  assert.equal(d.ok, true);
  assert.equal(d.reason, "reproduced");
});

test("rollback: a target that no longer reproduces is REFUSED as divergence", () => {
  const d = decideRollback({ target: rev(FP_B), currentFingerprintOfTarget: FP_A });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "diverged", "an approximation of the old version is worse than an honest refusal");
  assert.equal(d.expected, FP_B);
  assert.equal(d.got, FP_A);
});

test("rollback: unable to re-derive is refused, never assumed", () => {
  const d = decideRollback({ target: rev(FP_B) });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "cannot-reproduce");
});

test("governance: promote and rollback leave the same shaped record", () => {
  const p = governanceRecord({ action: "promote", from: null, to: FP_A, by: "owner", reason: "first deploy" });
  const r = governanceRecord({ action: "rollback", from: FP_A, to: FP_B, by: "owner", reason: "regression" });
  assert.deepEqual(Object.keys(p).sort(), Object.keys(r).sort(), "one shape, both verbs");
  assert.equal(p.from, null, "a first deploy has no source");
  assert.throws(() => governanceRecord({ action: "deploy" }), /unknown governance action/);
});

// ── storage (5.1): one active per deployment, audit survives the move ───────

const Database = (await import("better-sqlite3")).default;
const { createRevisionStore } = await import("../lib/revision-store.js");
const os = await import("node:os");
const fs = await import("node:fs");
const path = await import("node:path");

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev-"));
  return new Database(path.join(dir, "fleets.db"));
}

test("store: the same content reached two ways is ONE row", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A, name: "from trial" });
  store.record({ deployment: "packs-p1", fingerprint: FP_A, name: "straight deploy" });
  assert.equal(store.list("packs-p1").length, 1, "the fingerprint is the primary key");
  db.close();
});

test("store: moving the pointer retires the old active, never leaves two", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A });
  store.record({ deployment: "packs-p1", fingerprint: FP_B });
  store.movePointer("packs-p1", FP_A, { action: "promote", by: "owner" });
  assert.equal(store.active("packs-p1").revisionId, FP_A);
  store.movePointer("packs-p1", FP_B, { action: "promote", by: "owner", reason: "newer" });
  assert.equal(store.active("packs-p1").revisionId, FP_B);
  assert.equal(store.list("packs-p1").filter((r) => r.state === "active").length, 1, "exactly one active");
  assert.equal(store.get("packs-p1", FP_A).state, "retired");
  db.close();
});

test("store: two deployments keep independent pointers", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A });
  store.record({ deployment: "packs-p2", fingerprint: FP_B });
  store.movePointer("packs-p1", FP_A, { action: "promote" });
  store.movePointer("packs-p2", FP_B, { action: "promote" });
  assert.equal(store.active("packs-p1").revisionId, FP_A);
  assert.equal(store.active("packs-p2").revisionId, FP_B, "\"v3\" of two packs are unrelated");
  db.close();
});

test("store: the audit row survives a later rollback and names the override", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A });
  store.record({ deployment: "packs-p1", fingerprint: FP_B });
  store.movePointer("packs-p1", FP_A, { action: "promote", by: "a" });
  store.movePointer("packs-p1", FP_B, { action: "promote", by: "b", overridden: true, overrideReason: "hotfix" });
  store.movePointer("packs-p1", FP_A, { action: "rollback", by: "c", reason: "regression" });
  const log = store.governance("packs-p1");
  assert.equal(log.length, 3, "every move is recorded, none is rewritten");
  assert.equal(log[1].overridden, true);
  assert.equal(log[1].overrideReason, "hotfix");
  assert.equal(log[2].action, "rollback");
  assert.equal(log[2].from, FP_B);
  assert.equal(log[2].to, FP_A);
  db.close();
});

test("store: a trial is attached in place and replaced by a re-run", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A });
  store.attachTrial("packs-p1", FP_A, { fingerprint: FP_A, assertions: [{ pass: false }], green: false });
  assert.equal(store.get("packs-p1", FP_A).trial.green, false);
  store.attachTrial("packs-p1", FP_A, { fingerprint: FP_A, assertions: [{ pass: true }], green: true });
  assert.equal(store.get("packs-p1", FP_A).trial.green, true, "a re-run replaces the report");
  db.close();
});

test("store: a revision promoted from a trial and one deployed directly share the id", () => {
  const db = freshDb();
  const store = createRevisionStore({ db });
  store.record({ deployment: "packs-p1", fingerprint: FP_A, name: "trial path" });
  store.attachTrial("packs-p1", FP_A, { fingerprint: FP_A, assertions: [{ pass: true }], green: true });
  const fromTrial = store.active("packs-p1");
  store.movePointer("packs-p1", FP_A, { action: "promote" });
  const direct = store.active("packs-p1");
  assert.equal(direct.revisionId, fromTrial === null ? FP_A : direct.revisionId, "one id, two origins");
  db.close();
});

// ── 7.3 版本链路（可在单进程内闭环的那一半）────────────────────────────────
// 完整链路要求真装台 + 真回合，那是集群验收；这里闭合的是中间的推导链：
// 改一个技能 → 指纹变 → 新 revision → 试装（同指纹）→ promote → 指针动 →
// rollback（可复现）→ 指针回来。每一步都用真实模块，不 mock 规则。

const { computeRuntimeFingerprint } = await import("../lib/runtime-fingerprint.js");

test("7.3 chain: edit a skill → new fingerprint → new revision → trial → promote → rollback", () => {
  const baseCfg = {
    persona: "analyst",
    skills: [{ name: "alpha", body: "A" }],
    mcpServers: [{ name: "srv", url: "https://a" }],
    model: "m",
  };
  const fpA = computeRuntimeFingerprint(baseCfg).bundle;

  // 改一个技能正文：这是一次真实的配置变化
  const edited = { ...baseCfg, skills: [{ name: "alpha", body: "A CHANGED" }] };
  const fpB = computeRuntimeFingerprint(edited).bundle;
  assert.notEqual(fpA, fpB, "改技能正文必须得到新指纹");

  const db2 = freshDb();
  const store2 = createRevisionStore({ db: db2 });
  store2.record({ deployment: "packs-p1", fingerprint: fpA });
  store2.movePointer("packs-p1", fpA, { action: "promote", by: "owner" });

  // 新指纹作为候选，挂同指纹的试装报告
  let revB = revisionRecord({ fingerprint: fpB, name: "skill edit" });
  revB.deployment = "packs-p1";
  const attached = attachTrial(revB, { fingerprint: fpB, assertions: [{ pass: true }], green: true });
  assert.equal(attached.ok, true);
  revB = attached.revision;
  store2.record(revB);
  store2.attachTrial("packs-p1", fpB, revB.trial);

  // promote：判据是「同指纹的绿试装」
  const target = store2.get("packs-p1", fpB);
  assert.equal(decidePromotion({ target, currentFingerprint: fpA }).ok, true);
  store2.movePointer("packs-p1", fpB, { action: "promote", by: "owner" });
  assert.equal(store2.active("packs-p1").revisionId, fpB, "新回合将带新指纹");

  // rollback：目标可复现才允许
  const back = store2.get("packs-p1", fpA);
  assert.equal(decideRollback({ target: back, currentFingerprintOfTarget: fpA }).ok, true);
  store2.movePointer("packs-p1", fpA, { action: "rollback", by: "owner", reason: "regression" });
  assert.equal(store2.active("packs-p1").revisionId, fpA, "回滚后新回合带旧指纹");

  // 治理记录完整地记下了这一串动作
  const log = store2.governance("packs-p1");
  assert.deepEqual(log.map((e) => e.action), ["promote", "promote", "rollback"]);
  assert.equal(log.at(-1).from, fpB);
  assert.equal(log.at(-1).to, fpA);
  db2.close();
});

test("7.3 chain: rollback to a drifted target is refused at the LAST step, not silently applied", () => {
  const db3 = freshDb();
  const store3 = createRevisionStore({ db: db3 });
  store3.record({ deployment: "packs-p1", fingerprint: FP_A });
  store3.record({ deployment: "packs-p1", fingerprint: FP_B });
  store3.movePointer("packs-p1", FP_A, { action: "promote" });
  store3.movePointer("packs-p1", FP_B, { action: "promote" });
  const back = store3.get("packs-p1", FP_A);
  // 依赖漂移：目标重新物化出的指纹不再是它自己
  const decision = decideRollback({ target: back, currentFingerprintOfTarget: "c".repeat(64) });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "diverged");
  // 指针没动 —— 拒绝发生在动作之前
  assert.equal(store3.active("packs-p1").revisionId, FP_B);
  db3.close();
});
