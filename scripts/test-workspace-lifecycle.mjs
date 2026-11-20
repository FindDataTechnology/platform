#!/usr/bin/env node
// ── workspace-lifecycle tests (add-agent-builder-workspace 2.1) ─────────────
// Pins the ribbon to the SERVER's real state machine (server/routes/
// blueprints.js): approve needs green; cast needs approved + the approver;
// trial only exists after cast; sign needs a report and a stale sign re-opens
// it; reseal only in the green+signed+unmodified state; and the decisive one —
// editing a cast document returns it to DRAFT (the store clears the approval),
// so the ribbon must NEVER offer a fake "reseal" on an edited cast doc.
//
//   node --test scripts/test-workspace-lifecycle.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { teamRibbon } from "../web/src/lib/workspace-lifecycle.ts";

const ctx = (over = {}) => ({ verdictOk: true, userEmail: "me@x.io", saving: false, ...over });
const draft = (over = {}) => ({
  status: "draft",
  approvedBy: null,
  castPackId: null,
  castPackVersion: null,
  trialRanAt: null,
  signedBy: null,
  signedMatches: false,
  ...over,
});

test("draft: next=approve, gated on green validation", () => {
  const r = teamRibbon(draft(), ctx());
  assert.equal(r.next?.action, "approve");
  assert.equal(r.next?.enabled, true);
  assert.equal(r.noticeKey, null);
  const red = teamRibbon(draft(), ctx({ verdictOk: false }));
  assert.equal(red.next?.enabled, false);
  assert.equal(red.next?.reasonKey, "ribbonNeedGreen");
});

test("draft after a cast edit: draft stage with the recast note, never a fake reseal", () => {
  // The store resets status to draft + clears approvedBy on every edit, so an
  // edited cast document IS a draft — the ribbon must say so honestly.
  const r = teamRibbon(draft({ castPackId: "pack-1", castPackVersion: 3 }), ctx());
  assert.equal(r.next?.action, "approve");
  assert.equal(r.noticeKey, "ribbonRecastNote");
  assert.ok(!r.stages.some((s) => s.key === "reseal" && s.state === "current"));
});

test("approved: next=cast; non-approvers see a disabled cast with a reason", () => {
  const mine = teamRibbon(draft({ status: "approved", approvedBy: "me@x.io" }), ctx());
  assert.equal(mine.next?.action, "cast");
  assert.equal(mine.next?.enabled, true);
  const theirs = teamRibbon(draft({ status: "approved", approvedBy: "someone@else.io" }), ctx());
  assert.equal(theirs.next?.action, "cast");
  assert.equal(theirs.next?.enabled, false);
  assert.equal(theirs.next?.reasonKey, "ribbonOnlyApprover");
});

test("auth off (unknown email): the cast gate is NOT a false disable — the server decides", () => {
  const r = teamRibbon(draft({ status: "approved", approvedBy: "local@cell" }), ctx({ userEmail: null }));
  assert.equal(r.next?.enabled, true);
});

test("cast without trial: trial is the next action (trial rides AFTER cast)", () => {
  const r = teamRibbon(draft({ status: "cast", approvedBy: "me@x.io", castPackId: "p", castPackVersion: 1 }), ctx());
  assert.equal(r.next?.action, "trial");
  assert.equal(r.noticeKey, "ribbonCastRef");
  // The base stages all read done up to trial:
  const states = Object.fromEntries(r.stages.map((s) => [s.key, s.state]));
  assert.equal(states.draft, "done");
  assert.equal(states.cast, "done");
  assert.equal(states.trial, "current");
  assert.equal(states.sign, "upcoming");
});

test("cast with an unsigned report: sign is next", () => {
  const r = teamRibbon(draft({ status: "cast", approvedBy: "me@x.io", castPackId: "p", trialRanAt: 100 }), ctx());
  assert.equal(r.next?.action, "sign");
});

test("rerun report voids the old sign: sign re-opens, unsign offered, stale note", () => {
  const r = teamRibbon(
    draft({ status: "cast", approvedBy: "me@x.io", castPackId: "p", trialRanAt: 200, signedBy: "me@x.io", signedMatches: false }),
    ctx(),
  );
  assert.equal(r.next?.action, "sign");
  assert.equal(r.secondary?.action, "unsign");
  assert.equal(r.noticeKey, "ribbonSignStale");
});

test("green + signed + unmodified: reseal is next, all base stages done", () => {
  const r = teamRibbon(
    draft({ status: "cast", approvedBy: "me@x.io", castPackId: "p", trialRanAt: 200, signedBy: "me@x.io", signedMatches: true }),
    ctx(),
  );
  assert.equal(r.next?.action, "reseal");
  assert.equal(r.next?.enabled, true);
  assert.ok(r.stages.every((s) => s.key === "reseal" ? s.state === "current" : s.state === "done"));
});

test("reseal keeps the approver discipline", () => {
  const r = teamRibbon(
    draft({ status: "cast", approvedBy: "someone@else.io", castPackId: "p", trialRanAt: 200, signedBy: "me@x.io", signedMatches: true }),
    ctx(),
  );
  assert.equal(r.next?.action, "reseal");
  assert.equal(r.next?.enabled, false);
});

test("a save in flight disables the next action (nothing lies while writing)", () => {
  const r = teamRibbon(draft(), ctx({ saving: true }));
  assert.equal(r.next?.enabled, false);
});
