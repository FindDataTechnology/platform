// Unit tests — curation evidence shape and verdicts (change
// add-curation-evidence-gate, tasks 1.1–1.3 / 2.1).
// Run: node --test scripts/test-curation-evidence.mjs
//
// What is pinned here is the JUDGEMENT, not the plumbing:
//   · a complete block passes, and every missing piece is named by path;
//   · an axis that stopped at "needs-human" is incomplete, not "almost";
//   · an axis invented for the wrong species is refused (it would imply a
//     review step that does not exist);
//   · evidence state and supply state are ORTHOGONAL — both can be wrong at once
//     and neither may mask the other;
//   · expiry is a state, and the outward summary never carries the reviewer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AXES_BASE,
  AXES_PLUGIN,
  validateEvidence,
  evidenceState,
  isShippable,
  evidenceSummary,
  axesForSpecies,
} from "../lib/curation-evidence.js";

function block(over = {}) {
  return {
    axes: {
      security: { verdict: "pass", reason: "无危险能力" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "文档与用例齐" },
    },
    pin: { repo: "github.com/acme/tool", commit: "abc1234" },
    licence: "MIT-0",
    egress: "none",
    reviewedBy: "ops@acme",
    reviewedAt: "2026-11-01",
    ...over,
  };
}

function codes(errors) {
  return errors.map((e) => e.code).sort();
}

test("a complete block passes for both a pack and a plugin", () => {
  assert.deepEqual(validateEvidence(block(), { species: "pack" }), []);
  const plugin = block({
    axes: {
      ...block().axes,
      P1: { verdict: "pass", reason: "供给面只读" },
      P2: { verdict: "pass", reason: "无运行期下载" },
    },
  });
  assert.deepEqual(validateEvidence(plugin, { species: "plugin" }), []);
});

test("a missing block is 'unreviewed', with a path a human can act on", () => {
  const errors = validateEvidence(undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "evidence_missing");
  assert.equal(errors[0].path, "evidence");
});

test("each missing piece is named separately", () => {
  const errors = validateEvidence({ ...block(), pin: { repo: "github.com/acme/tool" }, egress: undefined, licence: "" }, { species: "pack" });
  assert.deepEqual(codes(errors), ["evidence_egress", "evidence_licence", "evidence_pin_ref"].sort());
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ["evidence.egress", "evidence.licence", "evidence.pin"]);
});

test("a floating pin (branch, no commit or tag) is refused", () => {
  const errors = validateEvidence(block({ pin: { repo: "github.com/acme/tool", branch: "main" } }));
  assert.ok(errors.some((e) => e.code === "evidence_pin_ref"));
  assert.match(errors.find((e) => e.code === "evidence_pin_ref").error, /floating branch/);
});

test("an axis that stopped at needs-human is incomplete, not a pass", () => {
  const errors = validateEvidence(
    block({ axes: { ...block().axes, quality: { verdict: "needs-human", reason: "等上游答复" } } }),
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "evidence_axis_incomplete");
  assert.equal(errors[0].path, "evidence.axes.quality.verdict");
  assert.match(errors[0].error, /unfinished axis is incomplete/);
});

test("a plugin entry without P1/P2 is refused, and an invented axis too", () => {
  const missing = validateEvidence(block(), { species: "plugin" });
  assert.deepEqual(codes(missing), ["evidence_axis_missing", "evidence_axis_missing"]);

  const invented = validateEvidence(
    block({ axes: { ...block().axes, P1: { verdict: "pass", reason: "x" }, P2: { verdict: "pass", reason: "y" } } }),
    { species: "mcp" },
  );
  assert.deepEqual(codes(invented), ["evidence_axis_unexpected", "evidence_axis_unexpected"]);
});

test("an axis without a reason is refused (a verdict alone is unfalsifiable)", () => {
  const errors = validateEvidence(block({ axes: { ...block().axes, security: { verdict: "pass" } } }));
  assert.deepEqual(codes(errors), ["evidence_axis_reason"]);
});

test("egress accepts the three forms and refuses a typo", () => {
  for (const egress of ["none", "open", "allowlist(api.example.com)", "allowlist(a.example.com, b.example.com)", { kind: "allowlist", hosts: ["a.example.com"] }]) {
    assert.deepEqual(validateEvidence(block({ egress })), [], `should accept ${JSON.stringify(egress)}`);
  }
  for (const egress of ["alowlist(a.example.com)", "allowlist()", "allowlist(a,,b)", { kind: "allowlist", hosts: [] }, ""]) {
    assert.ok(validateEvidence(block({ egress })).some((e) => e.code === "evidence_egress"), `should refuse ${JSON.stringify(egress)}`);
  }
});

test("the required axis set depends on the species", () => {
  assert.deepEqual(axesForSpecies("plugin"), [...AXES_BASE, ...AXES_PLUGIN]);
  assert.deepEqual(axesForSpecies("mcp"), [...AXES_BASE]);
});

test("state is complete / stale / missing and only complete is shippable", () => {
  assert.deepEqual(evidenceState({ evidence: block() }, { today: "2026-11-12" }), { state: "complete", reasons: [] });
  assert.equal(isShippable({ evidence: block() }, { today: "2026-11-12" }), true);

  const stale = evidenceState({ evidence: block({ reviewValidUntil: "2026-10-01" }) }, { today: "2026-11-12" });
  assert.equal(stale.state, "stale");
  assert.match(stale.reasons[0], /expired on 2026-10-01/);
  assert.equal(isShippable({ evidence: block({ reviewValidUntil: "2026-10-01" }) }, { today: "2026-11-12" }), false);

  const missing = evidenceState({ evidence: undefined });
  assert.equal(missing.state, "missing");
  assert.ok(missing.reasons.length > 0);
});

test("an empty reviewValidUntil never expires", () => {
  for (const value of [undefined, null, ""]) {
    const res = evidenceState({ evidence: block({ reviewValidUntil: value }) }, { today: "2030-01-01" });
    assert.equal(res.state, "complete", `reviewValidUntil=${JSON.stringify(value)} should not expire`);
  }
});

test("evidence state and supply state are orthogonal (design D2)", () => {
  // An unsupplied plugin with complete evidence, and a supplied one with no
  // evidence, are both legal states a reader must be able to show at once.
  const unsuppliedButReviewed = { id: "x", species: "plugin", evidence: block({ axes: { ...block().axes, P1: { verdict: "pass", reason: "a" }, P2: { verdict: "pass", reason: "b" } } }) };
  assert.equal(evidenceState(unsuppliedButReviewed, { today: "2026-11-12" }).state, "complete");

  const suppliedButUnreviewed = { id: "y", species: "plugin" };
  assert.equal(evidenceState(suppliedButUnreviewed).state, "missing");
});

test("the outward summary never carries the reviewer (design D5)", () => {
  const summary = evidenceSummary({ evidence: block() }, { today: "2026-11-12" });
  assert.equal("reviewedBy" in summary, false);
  assert.equal(JSON.stringify(summary).includes("ops@acme"), false);
  assert.equal(summary.state, "complete");
  assert.equal(summary.licence, "MIT-0");
  assert.deepEqual(Object.keys(summary.axes).sort(), ["licence", "quality", "security"]);
  // Verdicts travel; reasons do not (they may quote internal discussion).
  assert.equal("reason" in summary.axes.security, false);
});

test("a stale summary names the expiry so a reader can act on it", () => {
  const summary = evidenceSummary({ evidence: block({ reviewValidUntil: "2026-01-01" }) }, { today: "2026-11-12" });
  assert.equal(summary.state, "stale");
  assert.equal(summary.reviewValidUntil, "2026-01-01");
  assert.ok(Array.isArray(summary.reasons) && summary.reasons.length > 0);
});

// ── the outward contract, replayed ──────────────────────────────────────────
// docs/curation-evidence-fixtures.json is the artefact another repo's collector
// is asked to satisfy. Replaying it here (rather than trusting the prose) means
// the fixture CANNOT drift from the validator: change a code or a rule and this
// goes red until the file is updated.
test("the published fixture file matches the validator, case for case", () => {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "curation-evidence-fixtures.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.contract, "curation-evidence@1", "the fixture names the contract it pins");

  for (const c of doc.valid) {
    const { state, reasons } = evidenceState({ species: c.species, evidence: c.evidence }, { today: c.today ?? "2026-11-13" });
    assert.equal(state, "complete", `${c.name} must be complete, got ${state}: ${reasons.join("; ")}`);
  }

  for (const c of doc.invalid) {
    const { state } = evidenceState({ species: c.species, evidence: c.evidence }, { today: c.today ?? "2026-11-13" });
    assert.equal(state, c.expect.state, `${c.name} must be ${c.expect.state}, got ${state}`);
    if (c.expect.code) {
      const errors = validateEvidence(c.evidence, { species: c.species });
      const codes = errors.map((e) => e.code);
      assert.ok(
        codes.includes(c.expect.code),
        `${c.name}: expected code ${c.expect.code}, got [${codes.join(", ")}]`,
      );
    }
  }
});
