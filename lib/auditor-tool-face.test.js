// ── auditor-tool-face unit tests (widen-deputy-to-personal-domains 3.2/3.3) ──

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITOR_ALLOWED_TOOLS,
  AUDITOR_VERDICTS,
  auditorAllowedFor,
  defaultAuditorToolFace,
  isVerdict,
  validateAuditorToolFace,
} from "./auditor-tool-face.js";

describe("validateAuditorToolFace", () => {
  it("accepts the default face", () => {
    assert.equal(validateAuditorToolFace(defaultAuditorToolFace()).ok, true);
  });

  it("accepts an empty declaration (inherits nothing)", () => {
    assert.equal(validateAuditorToolFace(undefined).ok, true);
    assert.equal(validateAuditorToolFace([]).ok, true);
  });

  it("refuses a write or send tool and names it", () => {
    const res = validateAuditorToolFace(["decision_queue", "chat.message.send"]);
    assert.equal(res.ok, false);
    assert.deepEqual(res.rejected, ["chat.message.send"]);
    assert.match(res.error, /chat\.message\.send/);
  });

  it("refuses every execution-shaped tool even if it looks harmless", () => {
    for (const name of [
      "action_execute",
      "publish_pack",
      "delete_memory",
      "fleet_member_update",
      "wanxing_agent_pause",
    ]) {
      assert.equal(validateAuditorToolFace([name]).ok, false, `${name} must be refused`);
    }
  });

  it("refuses a non-string entry instead of ignoring it", () => {
    const res = validateAuditorToolFace([{ name: "decision_queue" }]);
    assert.equal(res.ok, false);
  });

  it("refuses a non-array payload", () => {
    assert.equal(validateAuditorToolFace("decision_queue").ok, false);
  });

  it("the allowlist contains nothing but read tools plus the verdict submit", () => {
    const writes = AUDITOR_ALLOWED_TOOLS.filter((t) => t !== "auditor_submit_verdict");
    assert.deepEqual(writes.filter((t) => /(send|publish|write|delete|create|update|deploy|pause|resume|remove|invoke|execute|toggle)/i.test(t)), []);
  });
});

describe("verdicts", () => {
  it("has exactly the three states", () => {
    assert.deepEqual(Object.values(AUDITOR_VERDICTS).sort(), ["agree", "block", "dissent"]);
  });

  it("rejects an invented verdict", () => {
    assert.equal(isVerdict("approve"), false);
    assert.equal(isVerdict("block"), true);
  });
});

describe("auditorAllowedFor", () => {
  it("refuses a fleet with no mandate at all", () => {
    assert.equal(auditorAllowedFor({ version: 2, domains: {} }), false);
    assert.equal(auditorAllowedFor(null), false);
  });

  it("refuses an advise-only mandate — a domain that exists but grants nothing", () => {
    assert.equal(auditorAllowedFor({ version: 2, domains: { ops: { mode: "advise" } } }), false);
  });

  it("allows a fleet whose mandate actually delegates something", () => {
    assert.equal(auditorAllowedFor({ version: 2, domains: { ops: { mode: "draft" } } }), true);
    assert.equal(auditorAllowedFor({ version: 2, domains: { ops: { mode: "act-silent" } } }), true);
  });
});

describe("mounted-surface parity (2026-11-10)", () => {
  it("the allowlist names real tools, not aspirational ones", () => {
    // 名字对不上就调不到：此前 memory_read / report_read 在系统里根本不存在。
    assert.ok(AUDITOR_ALLOWED_TOOLS.includes("auditor_submit_verdict"));
    assert.ok(AUDITOR_ALLOWED_TOOLS.includes("decision_queue"));
    assert.ok(AUDITOR_ALLOWED_TOOLS.includes("fleet_turns_read"), "报告读取的真名是 fleet_turns_read");
    assert.equal(AUDITOR_ALLOWED_TOOLS.includes("report_read"), false, "report_read 从未存在过");
    assert.equal(AUDITOR_ALLOWED_TOOLS.includes("memory_read"), false, "真名是 memory_query / memory_read_page");
  });
});
