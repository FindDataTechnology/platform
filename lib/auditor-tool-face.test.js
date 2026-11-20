// ── auditor-tool-face unit tests (widen-deputy-to-personal-domains 3.2/3.3) ──

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITOR_ALLOWED_TOOLS,
  AUDITOR_IN_SERVICE_TOOLS,
  AUDITOR_TOOL_FACE,
  AUDITOR_VERDICTS,
  auditorAllowedFor,
  auditorFaceForRoster,
  auditorMcpFace,
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

describe("auditor face is one source (2026-11-18, harden-auditor-runtime-face)", () => {
  it("AUDITOR_ALLOWED_TOOLS is exactly the flattened face — no second hand-written list", () => {
    const flattened = [...new Set(Object.values(AUDITOR_TOOL_FACE).flat())];
    assert.deepEqual([...AUDITOR_ALLOWED_TOOLS].sort(), flattened.sort());
  });

  it("every face tool is owned by the server its alias says it is (names move servers silently otherwise)", () => {
    // 归属表：谁在哪台服务器上。工具挪了服务器而面没改，组合期就调不到它。
    const owner = {
      report_status: "fleet",
      decision_queue: "fleet",
      auditor_submit_verdict: "fleet",
      fleet_list: "fleet-architect",
      fleet_spec_read: "fleet-architect",
      fleet_turns_read: "fleet-architect",
      memory_query: "fd-memory",
      memory_recent: "fd-memory",
      memory_overview: "fd-memory",
    };
    for (const [server, tools] of Object.entries(AUDITOR_TOOL_FACE)) {
      for (const tool of tools) {
        assert.equal(owner[tool], server, `${tool} 应属于 ${owner[tool]}，但面把它挂在 ${server}`);
      }
    }
    assert.deepEqual(Object.keys(owner).sort(), [...AUDITOR_ALLOWED_TOOLS].sort(), "归属表与面不同步");
  });

  it("auditorMcpFace() is a fresh mutable copy — mutating it cannot corrupt the frozen face", () => {
    const face = auditorMcpFace();
    face.fleet.push("cron_create");
    delete face["fd-memory"];
    assert.deepEqual(auditorMcpFace(), {
      fleet: ["report_status", "decision_queue", "auditor_submit_verdict"],
      "fleet-architect": ["fleet_list", "fleet_spec_read", "fleet_turns_read"],
      "fd-memory": ["memory_query", "memory_recent", "memory_overview"],
    });
  });

  it("auditorFaceForRoster keys on a real preset id and refuses nothing-ish input", () => {
    assert.deepEqual(auditorFaceForRoster("user-preset-8"), auditorMcpFace());
    for (const empty of [undefined, null, "", "   ", 42]) {
      assert.equal(auditorFaceForRoster(empty), null, `${String(empty)} 应返回 null`);
    }
  });
});

describe("in-service auditor posts keep working (2026-11-18)", () => {
  it("every tool a running auditor post calls each round is on the face", () => {
    // 生产实测：评测舰队 `审计岗` 每日 cadence，prompt 明写
    // fleet_list → fleet_turns_read → report_status 三态裁决。
    // 早期设计把 report_status 漏在面外，照原样上线会直接打断它。
    const faceTools = new Set(Object.values(AUDITOR_TOOL_FACE).flat());
    const missing = AUDITOR_IN_SERVICE_TOOLS.filter((t) => !faceTools.has(t));
    assert.deepEqual(missing, [], `收窄会打断在役审计岗：缺 ${missing.join(", ")}`);
  });

  it("the in-service set is not a backdoor — it adds no write surface", () => {
    // 补齐「在役必需项」不等于放宽到写面：它本身仍必须是只读 + 裁决提交。
    const writes = AUDITOR_IN_SERVICE_TOOLS.filter(
      (t) => t !== "auditor_submit_verdict" && /(send|publish|write|delete|create|update|deploy|pause|resume|invoke|execute|toggle)/i.test(t),
    );
    assert.deepEqual(writes, []);
    assert.ok(AUDITOR_ALLOWED_TOOLS.includes("report_status"), "report_status 必须在允许集里，否则保存期又把它拒了");
  });
});
