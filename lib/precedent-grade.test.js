// ── precedent-grade unit tests (widen-deputy-to-personal-domains 2.2-2.4) ────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRADES,
  canPromoteToAuto,
  citableGrades,
  classifyIndependence,
  classifyLegacyDecision,
  classifyProvenance,
  classifyRuling,
  consistency,
  deriveOwnerGrade,
  isCitableGrade,
  normalizeLegacyGrade,
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

  it("four grades are citable: the two owner grades plus the two independent agent grades", () => {
    assert.deepEqual(
      citableGrades().sort(),
      [GRADES.AGENT_INDEPENDENT, GRADES.AGENT_INDEPENDENT_UNVERIFIED, GRADES.OWNER_APPROVED, GRADES.OWNER_AUTHORED].sort(),
    );
    // The self-ruled grade must never join them — that is the whole point.
    assert.equal(isCitableGrade(GRADES.AGENT_SELF), false);
    assert.equal(isCitableGrade(GRADES.DEPUTY_RULED), false);
  });
});

describe("classifyIndependence (agent-decided-learning-loop D1/D2)", () => {
  const seats = (over) => ({
    proposer: "f1/m-proposer",
    decider: "f1/m-decider",
    grader: "f2/m-grader",
    deciderModel: "model-a",
    graderModel: "model-b",
    blind: true,
    ...over,
  });

  it("all five conditions met → agent-independent", () => {
    const { grade, independence } = classifyIndependence(seats());
    assert.equal(grade, GRADES.AGENT_INDEPENDENT);
    assert.equal(independence.ok, true);
    assert.equal(independence.verified, true);
    assert.equal(isCitableGrade(grade), true);
  });

  it("a deciding agent proposing its own item is agent-self", () => {
    const { grade, independence } = classifyIndependence(seats({ proposer: "f1/m-decider" }));
    assert.equal(grade, GRADES.AGENT_SELF);
    assert.equal(independence.proposer_ne_decider, false);
    assert.equal(isCitableGrade(grade), false);
  });

  it("the decider certifying itself is agent-self", () => {
    const { grade } = classifyIndependence(seats({ grader: "f1/m-decider" }));
    assert.equal(grade, GRADES.AGENT_SELF);
  });

  it("no grader → independent but unverified, not self", () => {
    const { grade, independence } = classifyIndependence({
      proposer: "f1/m-proposer",
      decider: "f1/m-decider",
    });
    assert.equal(grade, GRADES.AGENT_INDEPENDENT_UNVERIFIED);
    assert.equal(independence.ok, true);
    assert.equal(independence.verified, false);
    assert.equal(isCitableGrade(grade), true);
  });

  it("same model on both seats is NOT a second opinion — unverified, not self", () => {
    // The seats are still three distinct people; what failed is the CHECK.
    // Grading this `agent-self` would punish the ruling hardest exactly where
    // someone tried hardest to check it.
    const { grade, independence } = classifyIndependence(seats({ graderModel: "model-a" }));
    assert.equal(independence.model_differs, false);
    assert.equal(independence.ok, true);
    assert.equal(grade, GRADES.AGENT_INDEPENDENT_UNVERIFIED);
  });

  it("a non-blind grader input is unverified, not self", () => {
    const { grade, independence } = classifyIndependence(seats({ blind: false }));
    assert.equal(independence.blind, false);
    assert.equal(grade, GRADES.AGENT_INDEPENDENT_UNVERIFIED);
  });

  it("three distinct seats on one fleet still pass — the cycle check is what catches sameness", () => {
    const { grade } = classifyIndependence(seats({ grader: "f1/m-third" }));
    assert.equal(grade, GRADES.AGENT_INDEPENDENT);
  });

  it("an explicit chain that revisits a coordinate is a cycle → agent-self", () => {
    const { grade, independence } = classifyIndependence(
      seats({ proposer: "f1/a", decider: "f1/b", grader: "f1/c", chain: ["f1/a", "f1/b", "f1/c", "f1/b"] }),
    );
    assert.equal(independence.acyclic, false);
    assert.equal(independence.cycleAt, "f1/b");
    assert.equal(grade, GRADES.AGENT_SELF);
  });

  it("a chain longer than three hops is reported as a cycle, not silently truncated", () => {
    const { independence } = classifyIndependence(
      seats({ chain: ["f1/a", "f1/b", "f1/c", "f1/d"] }),
    );
    assert.equal(independence.acyclic, false);
    assert.equal(independence.cycleAt, "f1/d");
  });

  it("an owner label does not make agent seats independent", () => {
    const { grade } = classifyRuling({ resolvedBy: "owner", ...seats({ proposer: "f1/m-decider" }) });
    // resolvedBy === "owner" takes the owner path — this pins that the AGENT
    // path never consults the label. Same seats without the label must disagree.
    assert.notEqual(grade, GRADES.AGENT_INDEPENDENT);
    const agentPath = classifyRuling({ ...seats({ proposer: "f1/m-decider" }) });
    assert.equal(agentPath.grade, GRADES.AGENT_SELF);
  });

  it("legacy deputy-ruled normalizes to agent-self at the read face", () => {
    assert.equal(normalizeLegacyGrade(GRADES.DEPUTY_RULED), GRADES.AGENT_SELF);
    assert.equal(normalizeLegacyGrade(GRADES.OWNER_AUTHORED), GRADES.OWNER_AUTHORED);
    assert.equal(normalizeLegacyGrade(null), null);
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

describe("deriveOwnerGrade（实时路径：主人裁决不缺声明也能判出可引用级）", () => {
  it("没有推荐值 → 主人的独立判断", () => {
    assert.equal(deriveOwnerGrade({ recommendation: null, resolution: { choice: "a" } }), GRADES.OWNER_AUTHORED);
    assert.equal(deriveOwnerGrade({ recommendation: "", resolution: { choice: "a" } }), GRADES.OWNER_AUTHORED);
  });

  it("选择与推荐不同 → 否决了代理的倾向", () => {
    assert.equal(
      deriveOwnerGrade({ recommendation: "a", resolution: { choice: "b" } }),
      GRADES.OWNER_AUTHORED,
    );
  });

  it("驳回推荐 → 同样是独立判断（choice 为 null 那一支）", () => {
    assert.equal(
      deriveOwnerGrade({ recommendation: "a", resolution: { choice: null } }),
      GRADES.OWNER_AUTHORED,
    );
    assert.equal(deriveOwnerGrade({ recommendation: "a", resolution: {} }), GRADES.OWNER_AUTHORED);
  });

  it("选择恰好等于推荐 → 规格定义的「原样发出代理的稿」，可引用", () => {
    assert.equal(
      deriveOwnerGrade({ recommendation: "a", resolution: { choice: "a" } }),
      GRADES.OWNER_APPROVED,
    );
  });

  it("两条产出的等级都可被引用", () => {
    assert.equal(isCitableGrade(deriveOwnerGrade({ recommendation: null })), true);
    assert.equal(isCitableGrade(deriveOwnerGrade({ recommendation: "a", resolution: { choice: "b" } })), true);
  });

  it("空输入不抛，落可引用侧（主人车道没有『代理自行裁决』这种情形）", () => {
    assert.equal(deriveOwnerGrade(undefined), GRADES.OWNER_AUTHORED);
    assert.equal(deriveOwnerGrade(null), GRADES.OWNER_AUTHORED);
    assert.equal(deriveOwnerGrade({}), GRADES.OWNER_AUTHORED);
  });

  it("代理自裁仍走 classifyProvenance，不会借这里变成可引用", () => {
    assert.equal(classifyProvenance({ resolvedBy: "deputy" }), GRADES.DEPUTY_RULED);
  });
});

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
