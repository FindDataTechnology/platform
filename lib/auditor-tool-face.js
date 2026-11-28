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
// 2026-11-18（harden-auditor-runtime-face）：清单升级为**按服务器分组的面**。
// 旧清单漏了 report_status —— 而生产上的 `审计岗`（评测舰队）每轮都要用它报
// 三态裁决。这份清单之所以能缺一项还没人发现，恰恰因为它**从未在运行时执行**
// （只做保存期校验）。分组之后，同一个映射既是保存期的允许集，也是组合期真正
// 下发的白名单，两处不可能再漂。
//
//   fleet                report_status           本岗报数（在役审计岗必需）
//                        decision_queue          读常务岗待裁队列
//                        auditor_submit_verdict  唯一的写，写的是结论不是事实
//   fleet-architect      fleet_list              列舰队
//                        fleet_spec_read         读舰队结构与岗位
//                        fleet_turns_read        读回合与报数（原 report_read）
//   fd-memory            memory_query            按条件查记忆页
//                        memory_recent           最近记忆页
//                        memory_overview         自己的记忆概况
export const AUDITOR_TOOL_FACE = Object.freeze({
  fleet: Object.freeze(["report_status", "decision_queue", "auditor_submit_verdict"]),
  "fleet-architect": Object.freeze(["fleet_list", "fleet_spec_read", "fleet_turns_read"]),
  "fd-memory": Object.freeze(["memory_query", "memory_recent", "memory_overview"]),
});

/** 摊平并集 —— 保存期校验用的允许工具名清单（面是唯一真源）。 */
export const AUDITOR_ALLOWED_TOOLS = Object.freeze([
  ...new Set(Object.values(AUDITOR_TOOL_FACE).flat()),
]);

// 在役审计岗每轮都会调的工具（2026-11-18 线上实测：评测舰队 `审计岗` 每日 cadence，
// prompt 明写「fleet_list → fleet_turns_read → report_status 出三态裁决」）。
// 收窄任何一项都会直接打断一个正在跑的生产岗位，所以它被单独钉住：面里删掉其中
// 任何一个，测试必须变红。这不是「尽量别删」，是「删了必须有人看过」。
export const AUDITOR_IN_SERVICE_TOOLS = Object.freeze([
  "report_status",
  "fleet_list",
  "fleet_turns_read",
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
 * The auditor's MCP face as a plain mutable copy — the ONE accessor both
 * composition points (the member MCP patch writer and the tool-filter doc
 * writer) use, so the two layers can never disagree about what an auditor may
 * touch. Returns a fresh object: callers may mutate it freely.
 *
 * Whether a given post IS an auditor is a fleet-database question, not this
 * module's — this leaf imports nothing, so the caller decides and then asks
 * for the face.
 */
export function auditorMcpFace() {
  const out = {};
  for (const [server, tools] of Object.entries(AUDITOR_TOOL_FACE)) out[server] = [...tools];
  return out;
}

/**
 * The face for one roster preset id, or null when there is no preset to key it
 * by. Both composition points take this shape (a `faceForPreset(presetId)`
 * callable for the member patch, a `{presetId: face}` map for the filter doc),
 * so keeping the "no id ⇒ nothing" rule here means neither caller has to
 * re-derive it.
 */
export function auditorFaceForRoster(presetId) {
  if (typeof presetId !== "string" || !presetId.trim()) return null;
  return auditorMcpFace();
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
