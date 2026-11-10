// ── precedent-grade unit tests (widen-deputy-to-personal-domains 2.2-2.4) ────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRADES,
  canPromoteToAuto,
  citableGrades,
  classifyLegacyDecision,
  classifyProvenance,
  consistency,
  isCitableGrade,
} from "./precedent-grade.js";

describe("classifyProvenance", () => {
  it("a deputy ruling is never a precedent", () => {
    assert.equal(classifyProvenance({ resolvedBy: "deputy" }), GRADES.DEPUTY_RULED);
    assert.equal(isCitableGrade(GRADES.DEPUTY_RULED), false);
  });

  it("an owner's own words are owner-authored", () => {
    assert.equal(
      classifyProvenance({ resolvedBy: "owner", sourceKind: "owner-direct" }),
      GRADES.OWNER_AUTHORED,
    );
  });

  it("an owner sending the agent's draft unmodified is owner-approved", () => {
    assert.equal(
      classifyProvenance({ resolvedBy: "owner", sourceKind: "agent-draft", amended: false }),
      GRADES.OWNER_APPROVED,
    );
  });

  it("an EDITED draft is deputy-ruled: 'changed' cannot tell a typo fix from a rewrite", () => {
    assert.equal(
      classifyProvenance({ resolvedBy: "owner", sourceKind: "agent-draft", amended: true }),
      GRADES.DEPUTY_RULED,
    );
  });

  it("unknown provenance is deputy-ruled, never the generous side", () => {
    assert.equal(classifyProvenance({}), GRADES.DEPUTY_RULED);
    assert.equal(classifyProvenance({ resolvedBy: "owner" }), GRADES.DEPUTY_RULED);
    assert.equal(classifyProvenance(null), GRADES.DEPUTY_RULED);
  });

  it("only the two owner grades are citable", () => {
    assert.deepEqual(citableGrades().sort(), [GRADES.OWNER_APPROVED, GRADES.OWNER_AUTHORED].sort());
  });
});

describe("consistency", () => {
  const row = (over) => ({
    resolvedBy: "owner",
    recommendation: "approve",
    state: "approved",
    resolution: { choice: "approve" },
    ...over,
  });

  it("counts a matching approval as agreement", () => {
    const s = consistency([row()]);
    assert.equal(s.samples, 1);
    assert.equal(s.agrees, 1);
    assert.equal(s.rate, 1);
  });

  it("counts a conflicting approval as disagreement", () => {
    const s = consistency([row({ resolution: { choice: "reject" } })]);
    assert.equal(s.agrees, 0);
    assert.equal(s.rate, 0);
  });

  it("counts a rejection as disagreement", () => {
    const s = consistency([row({ state: "rejected" })]);
    assert.equal(s.agrees, 0);
  });

  it("excludes the agent's own rulings from the sample (no circular proof)", () => {
    const s = consistency([row({ resolvedBy: "deputy" }), row()]);
    assert.equal(s.samples, 1, "a deputy-ruled row must not count");
  });

  it("excludes rows with no recommendation", () => {
    const s = consistency([row({ recommendation: null })]);
    assert.equal(s.samples, 0);
    assert.equal(s.rate, null);
  });
});

describe("canPromoteToAuto", () => {
  it("refuses on insufficient samples even with a perfect rate", () => {
    const gate = canPromoteToAuto({ samples: 3, agrees: 3, rate: 1 });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "insufficient_samples");
  });

  it("refuses below the rate threshold", () => {
    const gate = canPromoteToAuto({ samples: 30, agrees: 18, rate: 0.6 });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "rate_below_threshold");
  });

  it("allows promotion when both hold", () => {
    const gate = canPromoteToAuto({ samples: 30, agrees: 27, rate: 0.9 });
    assert.equal(gate.ok, true);
  });

  it("treats missing stats as refusal", () => {
    assert.equal(canPromoteToAuto(null).ok, false);
    assert.equal(canPromoteToAuto({ samples: 0, rate: null }).ok, false);
  });
});

// ── 存量回填细分（2026-11-10）──────────────────────────────────────────────

describe("classifyLegacyDecision", () => {
  it("a deputy ruling stays non-citable", () => {
    assert.equal(classifyLegacyDecision({ resolvedBy: "deputy" }), GRADES.DEPUTY_RULED);
  });

  it("owner decided with NO recommendation → their own judgement", () => {
    assert.equal(classifyLegacyDecision({ resolvedBy: "owner", recommendation: null }), GRADES.OWNER_AUTHORED);
    assert.equal(classifyLegacyDecision({ resolvedBy: "owner", recommendation: "" }), GRADES.OWNER_AUTHORED);
  });

  it("owner chose AGAINST the recommendation → provably independent", () => {
    assert.equal(
      classifyLegacyDecision({ resolvedBy: "owner", recommendation: "a", resolution: { choice: "b" } }),
      GRADES.OWNER_AUTHORED,
    );
  });

  it("owner chose exactly the recommendation → cannot tell, stay conservative", () => {
    assert.equal(
      classifyLegacyDecision({ resolvedBy: "owner", recommendation: "a", resolution: { choice: "a" } }),
      GRADES.DEPUTY_RULED,
    );
  });

  it("a rejection with no choice against a recommendation is not citable", () => {
    assert.equal(
      classifyLegacyDecision({ resolvedBy: "owner", recommendation: "a", resolution: { choice: null } }),
      GRADES.DEPUTY_RULED,
    );
  });

  it("unknown provenance stays conservative", () => {
    assert.equal(classifyLegacyDecision(null), GRADES.DEPUTY_RULED);
    assert.equal(classifyLegacyDecision({}), GRADES.DEPUTY_RULED);
  });
});
