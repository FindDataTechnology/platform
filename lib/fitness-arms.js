// ── 三臂构造（establish-agent-role-and-fitness-plane 3.1）──────────────────────
//
// 判定要拿「同一个 agent 全预算」当对照，而那台对照必须与团队走**同一条装台链**
// （`provisionFleetFromTemplate`），否则两臂的账本字段不同、gold 不可比。
//
// 所以对照臂就是一个「单成员的舰队模板」：成员承载用 team 的根岗 preset（人格
// 一致，避免「换个人格赢/输」被算成编制的功劳），KPI 槽与团队根岗一致，节奏
// 一致，预算由 budget 段给。它不引入任何新的执行路径。
//
// 本文件是**纯构造 + 校验**，不装台、不点火——真跑是任务 4.1 的事（要活集群）。
// 这样「三臂同形」这件事可以在没有集群时被证明（记 `armShapeAgrees`）。
import { parseFleetTemplate } from "../server/fleet-template.js";

export const ARM_KINDS = Object.freeze(["control", "team", "ablation"]);

/** 两种输入形状都收：模板本体（`members` 在顶层）与包 manifest（`fleet.members`）。 */
export function normalizeTemplate(input) {
  if (!input || typeof input !== "object") return null;
  if (Array.isArray(input.members) || input.orchestration) return input;
  if (input.fleet && typeof input.fleet === "object") return input.fleet;
  return null;
}

/**
 * 从一份团队模板构造对照臂：单成员、根岗人格、同节奏、同 KPI。
 *
 * 为什么用根岗而不是「中立人格」：判定问的是「这支编制比一个人强吗」。换人格
 * 会把「人格差异」混进「编制差异」，两件事必须分开——设计上矩阵人格一致的裁决
 * 才可比；人格差异留给检出后单独变量。
 */
export function buildControlArm(rawTemplate, { budget, name } = {}) {
  const template = normalizeTemplate(rawTemplate);
  const members = Array.isArray(template?.members) ? template.members : [];
  if (!members.length) return { ok: false, error: "template has no members" };
  const root = members.find((m) => m?.parentRef == null) ?? members[0];
  const presetId = root?.target?.presetId ?? root?.target?.id ?? null;
  if (!presetId) return { ok: false, error: "root member has no preset target — cannot mint a comparable control arm" };
  const control = {
    name: name ?? `对照臂 ${template.name ?? ""}`.trim(),
    members: [
      {
        ref: "solo",
        title: root.title ?? "solo",
        parentRef: null,
        target: { ...(root.target ?? {}), presetId },
        kpiSlots: Array.isArray(root.kpiSlots) ? root.kpiSlots : [],
        cadence: root.cadence ? { ...root.cadence } : undefined,
      },
    ],
    // 对照臂没有任何编排边：一个人，没有交接、没有扇出。这不是简化，是定义。
    orchestration: { mode: "schedule", edges: [] },
  };
  return { ok: true, arm: { kind: "control", ref: "control", budget, template: control } };
}

/** 团队臂：原样（保留编排与全部成员）。 */
export function buildTeamArm(rawTemplate, { budget } = {}) {
  const template = normalizeTemplate(rawTemplate);
  if (!Array.isArray(template?.members) || !template.members.length) return { ok: false, error: "template has no members" };
  return { ok: true, arm: { kind: "team", ref: "team", budget, template: { ...template } } };
}

/**
 * 消融臂：去掉一个岗，并**清掉所有引用它的边**。
 *
 * 只删成员不清边是最容易犯的错：`parseFleetTemplate` 会拒收指向不存在成员的边，
 * 于是消融臂根本装不起来，而失败原因看起来像「模板坏了」而不是「消融没做对」。
 * 悬空的 parentRef 一并改挂到它的父级（缺父级则置 null）。
 */
export function buildAblationArm(rawTemplate, memberRef, { budget } = {}) {
  const template = normalizeTemplate(rawTemplate);
  const members = Array.isArray(template?.members) ? template.members : [];
  const target = members.find((m) => m?.ref === memberRef);
  if (!target) return { ok: false, error: `no member '${memberRef}' in template` };
  if (members.length <= 1) return { ok: false, error: "cannot ablate the only member — that arm would have nobody" };
  const keep = members.filter((m) => m.ref !== memberRef);
  const keptRefs = new Set(keep.map((m) => m.ref));
  const edges = (template.orchestration?.edges ?? []).filter((e) => keptRefs.has(e?.from) && keptRefs.has(e?.to));
  const next = {
    ...template,
    members: keep.map((m) =>
      m.parentRef === memberRef ? { ...m, parentRef: target.parentRef && keptRefs.has(target.parentRef) ? target.parentRef : null } : m,
    ),
    orchestration: { ...(template.orchestration ?? {}), edges },
  };
  return { ok: true, arm: { kind: "ablation", ref: `drop-${memberRef}`, memberRef, budget, template: next } };
}

/**
 * 三臂同形检查：三条臂都必须能过**同一个**解析器（`parseFleetTemplate`），并且
 * 成员目标类型一致。这是「同一条装台链」的可离线证明。
 */
export function armShapeAgrees(arms = []) {
  const problems = [];
  const kinds = new Set(arms.map((a) => a.kind));
  for (const k of ARM_KINDS) if (["control", "team"].includes(k) && !kinds.has(k)) problems.push(`missing-${k}-arm`);
  const shapes = [];
  for (const a of arms) {
    const parsed = parseFleetTemplate({ fleet: a.template });
    if (!parsed.ok) problems.push(`${a.ref}: parse failed — ${parsed.error}`);
    else shapes.push({ ref: a.ref, kind: a.kind, memberCount: parsed.template.members.length });
  }
  return { ok: problems.length === 0, problems, shapes };
}

/** 从团队模板一次性构造三臂（对照 + 团队 + 逐岗消融）。预算必须显式给。 */
export function buildArmSet(template, { budget, ablate = [] } = {}) {
  const out = [];
  const control = buildControlArm(template, { budget });
  if (!control.ok) return { ok: false, error: `control: ${control.error}` };
  out.push(control.arm);
  const team = buildTeamArm(template, { budget });
  if (!team.ok) return { ok: false, error: `team: ${team.error}` };
  out.push(team.arm);
  for (const ref of ablate) {
    const a = buildAblationArm(template, ref, { budget });
    if (!a.ok) return { ok: false, error: `ablation ${ref}: ${a.error}` };
    out.push(a.arm);
  }
  const shape = armShapeAgrees(out);
  if (!shape.ok) return { ok: false, error: `arms are not comparable: ${shape.problems.join("; ")}` };
  return { ok: true, arms: out, shape };
}
