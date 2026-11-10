// ── outbound-message unit tests (add-principal-disclosure-gate 1.x/2.x/4.x) ──

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_MODES,
  OUTBOUND_ACTION,
  gateOutboundMessage,
  noteBypassAttempt,
  renderForAudience,
} from "./outbound-message.js";

const policy = (mode, extra = {}) => ({
  version: 2,
  domains: { "external-comms": { mode, discloseScope: ["public", "internal"], revokeWindowMinutes: 10, ...extra } },
});
const agent = { kind: "agent", email: "owner@test" };

describe("gateOutboundMessage", () => {
  it("blocks when no mandate applies (fallback, caller decides)", () => {
    const res = gateOutboundMessage({ policy: policy("act-notify"), domain: "external-comms", text: "hi", principal: { kind: "copilot" } });
    assert.equal(res.decision, "fallback");
    assert.equal(res.ok, false);
  });

  it("advises instead of sending when the domain is advise-only", () => {
    const res = gateOutboundMessage({ policy: policy("advise"), domain: "external-comms", text: "好的", principal: agent });
    assert.equal(res.decision, "advise");
    assert.equal(res.ok, false);
  });

  it("sends and produces a ledger entry when in scope", () => {
    const res = gateOutboundMessage({
      policy: policy("act-notify"),
      domain: "external-comms",
      text: "明天下午三点见",
      to: "customer@x.com",
      channel: "email",
      principal: agent,
      channelRevocable: true,
      now: 1_000_000,
    });
    assert.equal(res.ok, true);
    assert.equal(res.decision, "execute");
    assert.equal(res.ledger.principal, "owner@test");
    assert.equal(res.ledger.audience, "email:customer@x.com");
    assert.match(res.ledger.contentDigest, /^[0-9a-f]{64}$/);
    assert.equal(res.ledger.reversibleUntil, 1_000_000 + 10 * 60_000);
  });

  it("judges the TEXT, not a summary: money in the body blocks even with clean provenance", () => {
    const res = gateOutboundMessage({
      policy: policy("act-notify"),
      domain: "external-comms",
      text: "这次报价 38 万元",
      principal: agent,
      declaredSources: [{ level: "public", ref: "kb:pricing" }],
    });
    assert.equal(res.ok, false);
    assert.equal(res.decision, "draft");
    assert.equal(res.verdict.reasons.includes("disclose_out_of_scope"), true);
    assert.ok(res.disclosure.violations.some((v) => v.level === "finance" && v.via === "pattern"));
  });

  it("blocks on a provenance level outside the scope even when the text is clean", () => {
    const res = gateOutboundMessage({
      policy: policy("act-notify"),
      domain: "external-comms",
      text: "下周安排已定",
      principal: agent,
      declaredSources: [{ level: "hr", ref: "memory:hr" }],
    });
    assert.equal(res.ok, false);
    assert.ok(res.disclosure.violations.some((v) => v.via === "provenance"));
  });

  it("refuses an empty message rather than sending whitespace", () => {
    assert.equal(gateOutboundMessage({ policy: policy("act-silent"), domain: "external-comms", text: "   ", principal: agent }).reason, "empty_message");
  });

  it("act-silent sends without a notify flag but still yields a ledger row", () => {
    const res = gateOutboundMessage({ policy: policy("act-silent"), domain: "external-comms", text: "已处理", principal: agent, channelRevocable: true });
    assert.equal(res.ok, true);
    assert.equal(res.verdict.notify, false);
    assert.ok(res.ledger);
  });
});

describe("renderForAudience", () => {
  const text = "报价单已发到您邮箱";

  it("labels internally and does not label externally", () => {
    assert.match(renderForAudience({ text, mode: IDENTITY_MODES.INTERNAL }), /AI 代理/);
    assert.equal(renderForAudience({ text, mode: IDENTITY_MODES.EXTERNAL }), text);
  });

  it("keeps the content identical across both forms (no drift)", () => {
    const internal = renderForAudience({ text, mode: IDENTITY_MODES.INTERNAL });
    const external = renderForAudience({ text, mode: IDENTITY_MODES.EXTERNAL });
    assert.ok(internal.includes(external), "the external body must be present verbatim inside the internal form");
  });

  it("does not attach a disclosure statement to the external form", () => {
    const external = renderForAudience({ text, mode: IDENTITY_MODES.EXTERNAL });
    assert.ok(!/AI|代理|automated/i.test(external), "an outward message must not self-declare");
  });
});

describe("registry shape and bypass detection", () => {
  it("declares the content field so the gate can read the real text", () => {
    assert.equal(OUTBOUND_ACTION.outbound, true);
    assert.deepEqual(OUTBOUND_ACTION.contentArgs, ["text"]);
  });

  it("records a bypass attempt without throwing", () => {
    const seen = [];
    const entry = noteBypassAttempt({ onRecord: (e) => seen.push(e), source: "bots.js:sendTo" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "outbound_bypass_attempt");
    assert.equal(entry.source, "bots.js:sendTo");
  });

  it("detection never breaks the caller", () => {
    assert.doesNotThrow(() => noteBypassAttempt({ onRecord: () => { throw new Error("boom"); } }));
  });
});

// ── 5.1 层级样本闸 ──────────────────────────────────────────────────────────

describe("canAutoSendAtLevel", () => {
  it("refuses when the level has no samples, even with a perfect domain rate", async () => {
    const { canAutoSendAtLevel } = await import("./personal-mandate.js");
    const gate = canAutoSendAtLevel({ level: "finance", levelSamples: { finance: 0 }, minSamples: 20 });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "insufficient_level_samples");
    assert.equal(gate.level, "finance");
  });

  it("refuses when the level cannot be established", async () => {
    const { canAutoSendAtLevel } = await import("./personal-mandate.js");
    assert.equal(canAutoSendAtLevel({ level: null }).reason, "unknown_level");
  });

  it("allows once that level has enough samples", async () => {
    const { canAutoSendAtLevel } = await import("./personal-mandate.js");
    assert.equal(canAutoSendAtLevel({ level: "public", levelSamples: { public: 25 } }).ok, true);
  });
});

// ── 5.2 无反向能力的渠道恒不自动 ────────────────────────────────────────────

describe("channel revocability", () => {
  it("falls back to draft when the channel cannot recall a message", () => {
    const res = gateOutboundMessage({
      policy: policy("act-silent"),
      domain: "external-comms",
      text: "已按您要求处理",
      principal: agent,
      channelRevocable: false,
    });
    assert.equal(res.ok, false);
    assert.equal(res.decision, "draft");
    assert.equal(res.reason, "channel_not_revocable");
  });

  it("sends when the channel can recall", () => {
    const res = gateOutboundMessage({
      policy: policy("act-silent"),
      domain: "external-comms",
      text: "已按您要求处理",
      principal: agent,
      channelRevocable: true,
    });
    assert.equal(res.ok, true);
  });

  it("refuses the level with no samples even on a revocable channel", () => {
    // 用范围内的层级来隔离这条闸：越界会先被 disclose_out_of_scope 挡下，
    // 那更具体、也更该优先——两者不是同一个失败。
    const res = gateOutboundMessage({
      policy: policy("act-notify"),
      domain: "external-comms",
      text: "排期已确认，下周启动",
      principal: agent,
      channelRevocable: true,
      declaredSources: [{ level: "internal", ref: "memory:plan" }],
      levelSamples: { internal: 0 },
    });
    assert.equal(res.decision, "draft");
    assert.equal(res.reason, "insufficient_level_samples");
  });

  it("reports the disclosure violation before the level gate (more specific first)", () => {
    const res = gateOutboundMessage({
      policy: policy("act-notify"),
      domain: "external-comms",
      text: "报价 38 万元已确认",
      principal: agent,
      channelRevocable: true,
      declaredSources: [{ level: "finance", ref: "memory:price" }],
      levelSamples: { finance: 0 },
    });
    assert.equal(res.decision, "draft");
    assert.equal(res.reason, "disclose_out_of_scope");
  });
});
