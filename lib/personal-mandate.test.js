// ── personal-mandate unit tests (add-personal-mandate) ──────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DECISION,
  MODES,
  NON_DOWNGRADABLE,
  allowedModesFor,
  checkDisclosure,
  checkReadScope,
  mergeMandatePolicies,
  modeOptionsFor,
  normalizeMandatePolicy,
  resolveMandate,
} from "./personal-mandate.js";

const agent = { kind: "agent" };
const copilot = { kind: "copilot" };

const writeAction = {
  id: "chat.message.send",
  risk: "write",
  outbound: true,
  revocable: true,
  contentArgs: ["message"],
};

describe("normalizeMandatePolicy", () => {
  it("treats the flat legacy shape as the ops domain, verbatim", () => {
    const legacy = {
      routes: { "routine-ops": "deputy", default: "owner" },
      maxSeverity: "normal",
      dailyBudget: 20,
      model: "m1",
    };
    const { ok, policy } = normalizeMandatePolicy(legacy);
    assert.equal(ok, true);
    assert.equal(policy.version, 2);
    assert.deepEqual(policy.domains.ops.routes, legacy.routes);
    assert.equal(policy.domains.ops.maxSeverity, "normal");
    assert.equal(policy.domains.ops.dailyBudget, 20);
    assert.equal(policy.domains.ops.model, "m1");
  });

  it("passes a v2 multi-domain shape through", () => {
    const { ok, policy } = normalizeMandatePolicy({
      version: 2,
      domains: { "external-comms": { mode: "draft", discloseScope: ["public"] } },
    });
    assert.equal(ok, true);
    assert.equal(policy.domains["external-comms"].mode, "draft");
    assert.deepEqual(policy.domains["external-comms"].discloseScope, ["public"]);
  });

  it("rejects an unknown domain name instead of silently degrading it", () => {
    const { ok, error } = normalizeMandatePolicy({
      version: 2,
      domains: { "extrnal-comms": { mode: "draft" } },
    });
    assert.equal(ok, false);
    assert.match(error, /unknown mandate domain/);
  });

  it("normalizes null to an empty policy", () => {
    const { ok, policy } = normalizeMandatePolicy(null);
    assert.equal(ok, true);
    assert.deepEqual(policy.domains, {});
  });

  it("keeps the legacy delegation fields on a v2 ops block (no silent reset on write)", () => {
    const { ok, policy } = normalizeMandatePolicy({
      version: 2,
      domains: {
        ops: {
          mode: "advise",
          enabled: true,
          routes: { "routine-ops": "deputy", default: "owner" },
          maxSeverity: "low",
          dailyBudget: 7,
          model: "m2",
          digest: "weekly",
          deputyMemberId: "m_deputy",
        },
      },
    });
    assert.equal(ok, true);
    const ops = policy.domains.ops;
    assert.equal(ops.enabled, true);
    assert.deepEqual(ops.routes, { "routine-ops": "deputy", default: "owner" });
    assert.equal(ops.maxSeverity, "low");
    assert.equal(ops.dailyBudget, 7);
    assert.equal(ops.model, "m2");
    assert.equal(ops.digest, "weekly");
    assert.equal(ops.deputyMemberId, "m_deputy");
  });
});

describe("resolveMandate — no mandate applies", () => {
  it("falls back for the copilot (no mandate may be acquired by the widen-tool-face role)", () => {
    const res = resolveMandate({
      policy: { domains: { ops: { mode: "act-silent" } } },
      domain: "ops",
      action: writeAction,
      principal: copilot,
    });
    assert.equal(res.decision, DECISION.FALLBACK);
    assert.deepEqual(res.reasons, ["not_agent"]);
  });

  it("advises with zero quota on an unconfigured domain", () => {
    const res = resolveMandate({
      policy: { domains: {} },
      domain: "research",
      action: { id: "x", risk: "write" },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.ADVISE);
    assert.equal(res.mode, MODES.advise);
    assert.deepEqual(res.reasons, ["no_policy"]);
  });
});

describe("resolveMandate — risk ceiling", () => {
  it("never auto-executes a destructive action, even at act-silent", () => {
    const res = resolveMandate({
      policy: { domains: { ops: { mode: "act-silent" } } },
      domain: "ops",
      action: { id: "wanxing.agent.deploy", risk: "destructive", revocable: true },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.equal(res.mode, MODES.draft);
    assert.ok(res.reasons.includes("non_downgradable"));
  });

  it("never auto-executes a publish action", () => {
    const res = resolveMandate({
      policy: { domains: { "external-comms": { mode: "act-notify" } } },
      domain: "external-comms",
      action: { id: "facet.pack.publish", risk: "publish", revocable: true },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("non_downgradable"));
  });

  it("exposes only advise/draft for non-downgradable risks in the settings options", () => {
    assert.deepEqual(allowedModesFor("publish"), [MODES.advise, MODES.draft]);
    assert.deepEqual(allowedModesFor("destructive"), [MODES.advise, MODES.draft]);
    for (const risk of NON_DOWNGRADABLE) {
      const options = modeOptionsFor({ risk }).map((o) => o.mode);
      assert.ok(!options.includes(MODES["act-notify"]));
      assert.ok(!options.includes(MODES["act-silent"]));
    }
  });
});

describe("resolveMandate — reversibility (D8)", () => {
  it("downgrades an action with no reverse operation to draft", () => {
    const res = resolveMandate({
      policy: { domains: { "external-comms": { mode: "act-notify", discloseScope: ["public"] } } },
      domain: "external-comms",
      action: { id: "chat.message.send", risk: "write", outbound: false, revocable: false },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("not_revocable"));
  });

  it("executes and notifies when the action is revocable", () => {
    const res = resolveMandate({
      policy: {
        domains: {
          "external-comms": { mode: "act-notify", discloseScope: ["public"], revokeWindowMinutes: 10 },
        },
      },
      domain: "external-comms",
      action: writeAction,
      args: { message: "好的，明天下午三点见" },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.EXECUTE);
    assert.equal(res.notify, true);
    assert.equal(res.mandateRef.revokeWindowMinutes, 10);
  });

  it("act-silent executes without notification", () => {
    const res = resolveMandate({
      policy: { domains: { advancement: { mode: "act-silent" } } },
      domain: "advancement",
      action: { id: "task.create", risk: "write", revocable: true },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.EXECUTE);
    assert.equal(res.notify, false);
  });
});

describe("resolveMandate — quota, expiry, cost", () => {
  const policy = {
    domains: { advancement: { mode: "act-notify", limits: { count: 5 } } },
  };

  it("allows the last unit of quota", () => {
    const res = resolveMandate({
      policy, domain: "advancement",
      action: { id: "task.create", risk: "write", revocable: true },
      usage: { count: 4 }, principal: agent,
    });
    assert.equal(res.decision, DECISION.EXECUTE);
  });

  it("steps down exactly one level when quota is exhausted", () => {
    const res = resolveMandate({
      policy, domain: "advancement",
      action: { id: "task.create", risk: "write", revocable: true },
      usage: { count: 5 }, principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("quota_exhausted"));
  });

  it("falls to draft on expiry, never upward", () => {
    const res = resolveMandate({
      policy: { domains: { advancement: { mode: "act-silent", expiresAt: 1000 } } },
      domain: "advancement",
      action: { id: "task.create", risk: "write", revocable: true },
      now: 2000, principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("expired"));
  });

  it("refuses to auto-execute a cost action without an amount ceiling", () => {
    const res = resolveMandate({
      policy: { domains: { ops: { mode: "act-notify" } } },
      domain: "ops",
      action: { id: "expense.pay", risk: "cost", revocable: true },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("cost_limit_missing"));
  });

  it("lets an action-level rule override the domain mode", () => {
    const res = resolveMandate({
      policy: {
        domains: {
          ops: { mode: "advise", actions: { "task.create": { mode: "act-notify" } } },
        },
      },
      domain: "ops",
      action: { id: "task.create", risk: "write", revocable: true },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.EXECUTE);
  });
});

describe("checkDisclosure", () => {
  const action = {
    id: "chat.message.send",
    risk: "write",
    outbound: true,
    revocable: true,
    contentArgs: ["message", "subject"],
  };

  it("blocks content from a provenance level outside the disclose scope", () => {
    const res = checkDisclosure({
      action,
      args: { message: "下周人员会调整", subject: "安排" },
      discloseScope: ["public", "internal"],
      declaredSources: [{ level: "hr", ref: "memory:hr-2026" }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.violations[0].level, "hr");
    assert.equal(res.violations[0].via, "provenance");
  });

  it("reads money as finance and blocks it", () => {
    const res = checkDisclosure({
      action,
      args: { message: "这次报价 38 万元" },
      discloseScope: ["public", "internal"],
    });
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.level === "finance" && v.via === "pattern"));
  });

  it("allows a finance mention when the scope includes finance", () => {
    const res = checkDisclosure({
      action,
      args: { message: "这次报价 38 万元" },
      discloseScope: ["public", "internal", "finance"],
    });
    assert.equal(res.ok, true);
  });

  it("blocks configured sensitive terms", () => {
    const res = checkDisclosure({
      action,
      args: { message: "客户腾龙那边已经签了" },
      discloseScope: ["public", "internal"],
      sensitiveTerms: [{ text: "腾龙", level: "confidential" }],
    });
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.via === "term"));
  });

  it("downgrades an outbound action to draft when disclosure is out of scope", () => {
    const res = resolveMandate({
      policy: { domains: { "external-comms": { mode: "act-notify", discloseScope: ["public"] } } },
      domain: "external-comms",
      action,
      args: { message: "预算 12 万，下周启动" },
      principal: agent,
    });
    assert.equal(res.decision, DECISION.DRAFT);
    assert.ok(res.reasons.includes("disclose_out_of_scope"));
    assert.equal(res.disclose.ok, false);
  });
});

describe("mergeMandatePolicies", () => {
  it("lets an override tighten but never widen", () => {
    const base = { version: 2, domains: { ops: { mode: "act-notify" } } };
    const loose = { version: 2, domains: { ops: { mode: "act-silent" } } };
    const merged = mergeMandatePolicies(base, loose);
    assert.equal(merged.domains.ops.mode, "act-notify");

    const tight = { version: 2, domains: { ops: { mode: "draft" } } };
    assert.equal(mergeMandatePolicies(base, tight).domains.ops.mode, "draft");
  });
});

describe("checkReadScope / 读闸（4.3）", () => {
  const policy = {
    version: 2,
    domains: {
      "external-comms": { mode: "act-silent", readScope: ["public", "internal"], discloseScope: ["public"] },
    },
  };

  it("allows a read inside read_scope even when disclose_scope is narrower", () => {
    const res = checkReadScope({ policy, domain: "external-comms", levels: ["internal"] });
    assert.equal(res.ok, true);
  });

  it("denies a read outside read_scope", () => {
    const res = checkReadScope({ policy, domain: "external-comms", levels: ["hr"] });
    assert.equal(res.ok, false);
    assert.deepEqual(res.denied, ["hr"]);
  });

  it("an empty/absent read_scope grants nothing", () => {
    const empty = { version: 2, domains: { research: { mode: "act-silent" } } };
    assert.equal(checkReadScope({ policy: empty, domain: "research", levels: ["internal"] }).ok, false);
    assert.equal(checkReadScope({ policy: empty, domain: "research", levels: [] }).ok, true);
  });

  it("a read action touching an out-of-scope level falls to advise, not draft", () => {
    const res = resolveMandate({
      policy,
      domain: "external-comms",
      action: { id: "memory.search", risk: "read" },
      principal: { kind: "agent" },
      requestLevels: ["hr"],
    });
    assert.equal(res.decision, DECISION.ADVISE);
    assert.deepEqual(res.reasons, ["read_out_of_scope"]);
  });
});
