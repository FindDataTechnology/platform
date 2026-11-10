#!/usr/bin/env node
// Cast state matrix (optimize-paas-module-audit N-21).
//
// The cast precondition collected five production patches, each adding an
// inline exception to the same if-chain (reseal / stale pointer / 409-same-name
// hint / provenance adoption / first-cast self reference). They are now one
// decision table in server/blueprint-cast-state.js. The route-level tests in
// test-blueprints.mjs pin each patch END-TO-END; this file pins the table
// itself, so the combination grid is visible in one place: adding a sixth rule
// means adding a row here, not another invisible branch.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAST_ADMISSION,
  classifyCastAdmission,
  isStalePointerAnswer,
  looksLikeStalePointerError,
  manifestCarriesSelfPlaceholder,
  mayAdoptSameNamePack,
  sameNameCandidates,
} from "../server/blueprint-cast-state.js";

const ME = "alice@corp.com";
const OTHER = "bob@corp.com";

const signedReport = { ranAt: 111, errors: [], green: true, signoff: { by: ME, at: 222, reportRanAt: 111 } };
// The live shape: a bad trial OVERWRITES the report (errors carry the vanished
// pack id) and the signoff goes with it — which is exactly why the reseal rule
// cannot fire and a separate repair door is needed.
const staleReport = { ranAt: 111, errors: ["trial aborted: Pack version not found"] };

function bp(over = {}) {
  return {
    id: "bp_1",
    status: "cast",
    approvedBy: ME,
    castPackId: "pk_live",
    trialReport: null,
    ...over,
  };
}

// ── Admission table ──────────────────────────────────────────────────────────
// status × (reseal signoff) × (stale report error) × (self placeholder in the
// pointed-at pack) — the full grid the five patches jointly define.

const ADMISSION_MATRIX = [
  {
    name: "approved draft: ordinary path, no manifest fetch involved",
    blueprint: bp({ status: "approved", castPackId: null, trialReport: null }),
    manifest: null,
    expect: { allowed: true, reason: CAST_ADMISSION.APPROVED },
  },
  {
    name: "draft status: approval must come first",
    blueprint: bp({ status: "draft", castPackId: null }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "cast + green signed report by the approver: reseal",
    blueprint: bp({ trialReport: signedReport }),
    manifest: null,
    expect: { allowed: true, reason: CAST_ADMISSION.RESEAL },
  },
  {
    name: "cast + report signed by someone else: not reseal",
    blueprint: bp({ trialReport: { ...signedReport, signoff: { by: OTHER, at: 222, reportRanAt: 111 } } }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "cast + signoff belongs to an older run (reportRanAt ≠ ranAt): not reseal",
    blueprint: bp({ trialReport: { ...signedReport, ranAt: 999 } }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "cast + stale-pointer report with signoff wiped: repair entry stays open",
    blueprint: bp({ trialReport: staleReport, approvedBy: ME }),
    manifest: null,
    expect: { allowed: true, reason: CAST_ADMISSION.STALE_POINTER },
  },
  {
    name: "cast + stale-pointer report but no pack id: nothing to repair, blocked",
    blueprint: bp({ trialReport: staleReport, castPackId: null }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "cast + v1 froze {{PACK_ID:self}}: self-pending repair",
    blueprint: bp({ trialReport: null }),
    manifest: { fleet: { presetId: "{{PACK_ID:self}}" } },
    expect: { allowed: true, reason: CAST_ADMISSION.SELF_PENDING },
  },
  {
    name: "cast + self reference already resolved: ordinary 409",
    blueprint: bp({ trialReport: null }),
    manifest: { fleet: { presetId: "pk_resolved" } },
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "cast + no report and no manifest fetch: blocked",
    blueprint: bp({ trialReport: null }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    name: "already-cast by someone else's approval: reseal rules do not fire",
    blueprint: bp({ approvedBy: OTHER, trialReport: signedReport }),
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
  {
    // Deliberate: the stale-pointer rule is NOT approver-gated, because it is
    // the only door that lets a stuck blueprint be repaired at all. The approver
    // discipline is a separate 403 in the route.
    name: "cast + stale report approved by someone else: still admitted for repair",
    blueprint: bp({ approvedBy: OTHER, trialReport: staleReport }),
    manifest: null,
    expect: { allowed: true, reason: CAST_ADMISSION.STALE_POINTER },
  },
  {
    name: "no blueprint at all",
    blueprint: null,
    manifest: null,
    expect: { allowed: false, reason: CAST_ADMISSION.BLOCKED },
  },
];

for (const row of ADMISSION_MATRIX) {
  test(`admission · ${row.name}`, () => {
    const got = classifyCastAdmission({
      blueprint: row.blueprint,
      userEmail: ME,
      castPackManifest: row.manifest,
    });
    assert.deepEqual(got, row.expect);
  });
}

// ── The pieces ───────────────────────────────────────────────────────────────

test("stale-pointer error detector: matches both wordings, ignores unrelated errors", () => {
  assert.equal(looksLikeStalePointerError(["trial aborted: Pack version not found"]), true);
  assert.equal(looksLikeStalePointerError(["Pack not found"]), true);
  assert.equal(looksLikeStalePointerError(["something else exploded"]), false);
  assert.equal(looksLikeStalePointerError([]), false);
  assert.equal(looksLikeStalePointerError(null), false);
  assert.equal(looksLikeStalePointerError("Pack not found"), false, "a bare string is not the report shape");
});

test("self-placeholder detector reads the published manifest, not the draft", () => {
  assert.equal(manifestCarriesSelfPlaceholder({ a: { b: "{{PACK_ID:self}}" } }), true);
  assert.equal(manifestCarriesSelfPlaceholder({ a: { b: "{{PACK_ID}}" } }), false, "bare form is not the frozen self ref");
  assert.equal(manifestCarriesSelfPlaceholder({ a: "pk_123" }), false);
  assert.equal(manifestCarriesSelfPlaceholder(null), false);
});

test("publish answer classification: 404 and the same-name 409 both mean stale pointer", () => {
  assert.equal(isStalePointerAnswer({ ok: false, status: 404 }), true);
  assert.equal(isStalePointerAnswer({ ok: false, status: 409, body: { error: "同名包已存在（pk_x）" } }), true);
  assert.equal(isStalePointerAnswer({ ok: false, status: 409, body: { error: "validation failed" } }), false);
  assert.equal(isStalePointerAnswer({ ok: false, status: 500 }), false);
  assert.equal(isStalePointerAnswer({ ok: true, status: 200 }), false);
  assert.equal(isStalePointerAnswer(null), false);
});

test("same-name candidates: body packId first, then the opaque token from the message", () => {
  assert.deepEqual(sameNameCandidates({ ok: false, status: 409, body: { packId: "pk_abcdefghijklmnop" } }), [
    "pk_abcdefghijklmnop",
  ]);
  assert.deepEqual(
    sameNameCandidates({ ok: false, status: 409, body: { error: "同名包已存在：pk_abcdefghijklmnop 请改名" } }),
    ["pk_abcdefghijklmnop"],
  );
  assert.deepEqual(sameNameCandidates({ ok: false, status: 409, body: { error: "同名包已存在" } }), [], "no id to try");
  assert.deepEqual(sameNameCandidates({ ok: true }), []);
});

test("provenance adoption: only this blueprint's own pack, and never another author's", () => {
  const own = { manifest: { _casting: { blueprintId: "bp_1" } }, authorEmail: ME };
  assert.equal(mayAdoptSameNamePack({ row: own, blueprintId: "bp_1", userEmail: ME }), true);

  const otherBlueprint = { manifest: { _casting: { blueprintId: "bp_2" } }, authorEmail: ME };
  assert.equal(
    mayAdoptSameNamePack({ row: otherBlueprint, blueprintId: "bp_1", userEmail: ME }),
    false,
    "a same-name pack cast by a different blueprint is someone else's product",
  );

  const otherAuthor = { manifest: { _casting: { blueprintId: "bp_1" } }, authorEmail: OTHER };
  assert.equal(mayAdoptSameNamePack({ row: otherAuthor, blueprintId: "bp_1", userEmail: ME }), false);

  const noAuthorRecorded = { manifest: { _casting: { blueprintId: "bp_1" } } };
  assert.equal(
    mayAdoptSameNamePack({ row: noAuthorRecorded, blueprintId: "bp_1", userEmail: ME }),
    true,
    "an unrecorded author does not veto provenance already proven by _casting",
  );

  const snakeCaseAuthor = { manifest: { _casting: { blueprintId: "bp_1" } }, author_email: OTHER };
  assert.equal(mayAdoptSameNamePack({ row: snakeCaseAuthor, blueprintId: "bp_1", userEmail: ME }), false);

  assert.equal(mayAdoptSameNamePack({ row: null, blueprintId: "bp_1", userEmail: ME }), false);
  assert.equal(mayAdoptSameNamePack({ row: own, blueprintId: null, userEmail: ME }), false);
});
