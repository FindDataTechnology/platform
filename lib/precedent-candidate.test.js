// ── precedent-candidate unit tests (widen-deputy-to-personal-domains 4.x) ─────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_STATUS,
  isCitableCandidate,
  normalizeRuleText,
  ruleKey,
  validateRule,
} from "./precedent-candidate.js";

describe("normalizeRuleText / ruleKey", () => {
  it("collapses whitespace so pure-spacing variants dedupe together", () => {
    assert.equal(normalizeRuleText("  同类交期  最多延 1 天 "), "同类交期 最多延 1 天");
    // Same sentence, different spacing → one key, so the owner is not asked twice.
    assert.equal(ruleKey("  同类交期  最多延 1 天 "), ruleKey("同类交期 最多延 1 天"));
  });

  it("gives the same key for the same normalized text", () => {
    assert.equal(ruleKey(" supplier: 交期最多延 1 天 "), ruleKey("supplier: 交期最多延 1 天"));
  });

  it("gives different keys for different rules", () => {
    assert.notEqual(ruleKey("交期最多延 1 天"), ruleKey("交期最多延 3 天"));
  });

  it("returns null for empty input instead of a colliding key", () => {
    assert.equal(ruleKey(""), null);
    assert.equal(ruleKey(null), null);
  });
});

describe("validateRule", () => {
  it("accepts a rule of useful length", () => {
    const res = validateRule("同类交期请求最多延 1 天，且需客户书面确认");
    assert.equal(res.ok, true);
    assert.ok(res.rule.length >= 8);
  });

  it("refuses a rule too short to constrain anything", () => {
    const res = validateRule("延 1 天");
    assert.equal(res.ok, false);
    assert.match(res.error, /too short/);
  });

  it("refuses empty and over-long rules", () => {
    assert.equal(validateRule("").ok, false);
    assert.equal(validateRule(null).ok, false);
    assert.equal(validateRule("规".repeat(501)).ok, false);
  });
});

describe("citable", () => {
  it("only an approved candidate is citable", () => {
    assert.equal(isCitableCandidate(CANDIDATE_STATUS.APPROVED), true);
    assert.equal(isCitableCandidate(CANDIDATE_STATUS.CANDIDATE), false);
    assert.equal(isCitableCandidate(CANDIDATE_STATUS.REJECTED), false);
  });
});
