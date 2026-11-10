// ── personal-agent-readiness unit tests (2026-11-10) ────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessPersonalAgent } from "./personal-agent-readiness.js";

const good = {
  mandate: { version: 2, domains: { ops: { mode: "draft" } } },
  domainMap: [{ source: "cross-line-blocker", enabled: true }],
  hasAuditor: true,
  verdictTokenConfigured: true,
  citablePrecedents: 7,
  levelSamples: { public: 30 },
  consistency: {},
};

describe("assessPersonalAgent", () => {
  it("a fully configured agent is ready with no warnings", () => {
    const r = assessPersonalAgent(good);
    assert.equal(r.ready, true);
    assert.equal(r.warns, 0);
    assert.equal(r.verdict, "配置完整");
  });

  it("an untouched install is blocked on both grant and intake, and says why", () => {
    const r = assessPersonalAgent({ mandate: { version: 2, domains: { ops: { mode: "advise" } } }, domainMap: [] });
    assert.equal(r.ready, false);
    assert.equal(r.blocked, 2);
    assert.match(r.verdict, /还不能用/);
    const ids = r.items.filter((i) => !i.ok && i.severity === "blocked").map((i) => i.id);
    assert.deepEqual(ids.sort(), ["intake-open", "mandate-grants"]);
  });

  it("advise is not a grant", () => {
    const r = assessPersonalAgent({ ...good, mandate: { version: 2, domains: { ops: { mode: "advise" } } } });
    assert.equal(r.ready, false);
    assert.ok(r.items.find((i) => i.id === "mandate-grants").detail.includes("只给建议"));
  });

  it("auto mode without a verdict token is blocked (outbound would fail closed silently)", () => {
    const r = assessPersonalAgent({
      ...good,
      mandate: { version: 2, domains: { ops: { mode: "act-notify" } } },
      verdictTokenConfigured: false,
    });
    assert.equal(r.ready, false);
    assert.ok(r.items.some((i) => i.id === "verdict-token" && !i.ok && i.severity === "blocked"));
  });

  it("no citable precedents is a warning, not a block — it still runs, blind", () => {
    const r = assessPersonalAgent({ ...good, citablePrecedents: 0 });
    assert.equal(r.ready, true);
    assert.ok(r.hasAuditor === undefined); // guard: helper result has no auditor field
    assert.ok(r.items.some((i) => i.id === "precedents" && !i.ok && i.severity === "warn"));
  });

  it("missing auditor is a warning", () => {
    const r = assessPersonalAgent({ ...good, hasAuditor: false });
    assert.equal(r.ready, true);
    assert.ok(r.items.some((i) => i.id === "auditor" && i.severity === "warn" && !i.ok));
  });

  it("thin level samples only matter once a domain is set to auto", () => {
    const draftOnly = assessPersonalAgent({ ...good, levelSamples: {} });
    assert.equal(draftOnly.items.some((i) => i.id === "level-samples"), false, "draft 模式下不提示层级样本");

    const auto = assessPersonalAgent({
      ...good,
      mandate: { version: 2, domains: { ops: { mode: "act-silent" } } },
      levelSamples: { finance: 0 },
    });
    const item = auto.items.find((i) => i.id === "level-samples");
    assert.ok(item && !item.ok);
    assert.match(item.detail, /finance=0/);
  });

  it("low consistency with enough samples becomes a warning naming the domain", () => {
    const r = assessPersonalAgent({ ...good, consistency: { ops: { samples: 9, rate: 0.44 } } });
    const item = r.items.find((i) => i.id === "consistency");
    assert.ok(item && !item.ok);
    assert.match(item.detail, /ops=44%/);
  });

  it("low consistency with too few samples is not reported (noise)", () => {
    const r = assessPersonalAgent({ ...good, consistency: { ops: { samples: 2, rate: 0 } } });
    assert.equal(r.items.some((i) => i.id === "consistency"), false);
  });

  it("every item carries a fix, so the verdict is actionable", () => {
    const r = assessPersonalAgent({});
    for (const item of r.items) {
      assert.ok(typeof item.fix === "string" && item.fix.length > 5, `${item.id} lacks a fix`);
    }
  });
});
