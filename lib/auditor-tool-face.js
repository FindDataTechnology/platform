// ── Auditor tool face (widen-deputy-to-personal-domains 3.2/3.3) ─────────────
//
// The auditor exists to disagree. That only works if it cannot do anything —
// an auditor that can send, write, or execute becomes another actor to police
// instead of a check on the actors.
//
// So the face is deny-by-default: an allowlist of read/summary tools, and
// anything not on it is refused at save time rather than filtered at call time.
// Refusing at save means a mistake is loud on the settings page instead of
// silent at 3am.
//
// Leaf module: imports nothing.

export const AUDITOR_VERDICTS = Object.freeze({
  AGREE: "agree",
  DISSENT: "dissent",
  BLOCK: "block",
});

// Read-only + verdict submission. Names are the platform's own tool names; a
// tool that is not here cannot be granted to an auditor.
//
// 2026-11-10 修正：此前清单里有三个名字在系统里**根本不存在**（memory_read /
// memory_overview 拼错、report_read 从来没有），等于给审计官开了一张空工具面：
// 声明得出来、保存得进去，运行时一个都调不到，而且不报错。现在全部改成真实
// 工具名，并由 scripts/test-auditor-tool-mounting.mjs 钉住「声明必须已挂载」。
//
//   decision_queue        fleet-mcp          读常务岗待裁队列
//   fleet_spec_read       fleet-architect-mcp 读舰队结构与岗位
//   fleet_turns_read      fleet-architect-mcp 读回合与报数（原 report_read）
//   memory_query          fd-memory          按条件查记忆页
//   memory_recent         fd-memory          最近记忆页
//   memory_overview       fd-memory          自己的记忆概况
//   auditor_submit_verdict fleet-mcp         唯一的写，写的是结论不是事实
export const AUDITOR_ALLOWED_TOOLS = Object.freeze([
  "decision_queue",
  "fleet_spec_read",
  "fleet_turns_read",
  "memory_query",
  "memory_recent",
  "memory_overview",
  "auditor_submit_verdict",
]);

const WRITE_VERBS = /\b(send|publish|write|delete|create|update|deploy|pause|resume|add|remove|invoke|execute|toggle)\b/i;

export function isVerdict(value) {
  return Object.values(AUDITOR_VERDICTS).includes(value);
}

/**
 * Validate a declared auditor tool face.
 *
 * Returns { ok, error?, rejected? } — rejected lists every offending name so
 * the settings page can name them instead of saying "invalid".
 */
export function validateAuditorToolFace(tools) {
  if (tools === undefined || tools === null) return { ok: true };
  if (!Array.isArray(tools)) return { ok: false, error: "tool face must be an array" };

  const rejected = [];
  for (const raw of tools) {
    if (typeof raw !== "string" || !raw.trim()) {
      rejected.push(String(raw));
      continue;
    }
    const name = raw.trim();
    // Allowlist first: a name that merely *looks* read-only is still refused.
    if (!AUDITOR_ALLOWED_TOOLS.includes(name)) {
      rejected.push(name);
      continue;
    }
    // Belt and braces: even if someone adds a write tool to the allowlist by
    // mistake, the verb check refuses it in the same pass.
    if (WRITE_VERBS.test(name) && name !== "auditor_submit_verdict") rejected.push(name);
  }

  if (rejected.length === 0) return { ok: true };
  return {
    ok: false,
    error: `auditor may only hold read tools; refused: ${[...new Set(rejected)].join(", ")}`,
    rejected: [...new Set(rejected)],
  };
}

/** The face an auditor gets when it declares nothing. */
export function defaultAuditorToolFace() {
  return [...AUDITOR_ALLOWED_TOOLS];
}

/**
 * Whether a fleet may hold an auditor at all: it needs a mandate that actually
 * grants something, because an auditor with nothing to audit is ceremony.
 *
 * "Has a domain key" is NOT the test: the `ops` domain always exists (it carries
 * the legacy delegation defaults, whose mode is `advise`). An `advise`-only
 * mandate delegates nothing, so there is nothing to disagree with.
 */
export function auditorAllowedFor(policy) {
  const domains = policy?.domains ?? {};
  return Object.values(domains).some((block) => {
    const mode = block?.mode;
    return mode === "draft" || mode === "act-notify" || mode === "act-silent";
  });
}
