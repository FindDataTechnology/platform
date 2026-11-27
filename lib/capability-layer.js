// ── 能力层（openspec: capability-layer）─────────────────────────────────────
//
// 一个能力条目的三轴模型，加上「pack / team / agent 三种作用域返回同一形状」的
// 统一推导。纯函数，无 DB、无 env、无缓存——与 lib/pack-pillars.js 同一条纪律。
//
// 为什么要有这一层，而不是继续用支柱：
//   · 支柱只覆盖 memory / toolkit / dashboard，**skills 没有面**；
//   · 角色声明写死了「只能取 pack 的子集」，而 agent 会迭代出自己的版本
//     （skill-self-evolution 已有闭环），租赁来的 agent 还可能不公开内部；
//   · 三个作用域各推一遍就会漂移，这正是 pillar-surfaces 当初要解决的问题。
//
// 三轴**正交，不互相推导**：origin 不决定 visibility，visibility 不决定 scope。
// 这条是刻意的——同一个自演化能力也可以被团队共享，把任何一条产品主张写死
// 都是在替使用者做决定。
//
// 本模块包装 derivePillars 而不是重写它：那三面已被 gateway 消费，重写会同时
// 改动它们并丢掉支柱已有的 invalid 态与 errors 路径。

import { derivePillars } from "./pack-pillars.js";

export const ORIGIN = Object.freeze(["pack", "team", "agent", "evolved"]);
export const VISIBILITY = Object.freeze(["private", "tenant", "public"]);
export const SCOPE = Object.freeze(["shared", "pinned", "local"]);

/** 推导结果里「解析不到」的闭集原因。闭集是为了读面能给出确定的一句话。 */
export const UNRESOLVED_REASON = Object.freeze({
  NOT_DECLARED: "not-declared",
  NOT_VISIBLE: "not-visible",
  SERVER_UNAVAILABLE: "server-unavailable",
});

/**
 * 把两张表里各自一套的可见性词汇归一到本层的三值。
 *
 * 生产实测 2026-11-28：`skills.visibility` 用 public/group/unlisted，
 * `mcp_servers.visibility` 用 public/group-restricted/internal/null——5 种取值
 * 两套词汇。归一必须有单一实现，否则下次又是两张表各说各话。
 *
 * 默认值是 private：租来的 agent 不公开内部，这条不能靠调用方记得传。
 */
export function normalizeVisibility(raw) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "public") return "public";
  // group / group-restricted 都是「一个具名集合可见」——在本层就是 tenant
  // （同租户内可见）。unlisted 是「已登记但不进公开面」，与 tenant 同义。
  if (v === "group" || v === "group-restricted" || v === "unlisted") return "tenant";
  // internal / null / 任何未知值 ⇒ private。未知值不放宽是刻意的：
  // 一个拼错的可见性不该意外变成公开。
  return "private";
}

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

/** 一条能力的标准形状。所有作用域都必须产出这个形状。 */
function entry({ kind, name, origin, visibility, scope, lineage = null, detail = null }) {
  return { kind, name, origin, visibility: normalizeVisibility(visibility), scope, lineage, detail };
}

// ── skills 面（支柱缺的那一面）──────────────────────────────────────────────

/**
 * 一个角色实际拿到的 skills。
 *
 * 与 lib/agent-serving.js::roleSkills() 的关键差别：那条路径对解析不到的声明
 * 做 `filter(Boolean)` **静默丢弃**——一个能力无声消失。这里返回 resolved /
 * unresolved 两段，未解析项带闭集原因。
 */
function skillEntries(manifest, agent) {
  const packSkills = asArray(manifest?.skills);
  const byName = new Map(packSkills.filter((s) => s?.name).map((s) => [s.name, s]));
  const declared = agent?.resources?.skills;
  const resolved = [];
  const unresolved = [];

  if (Array.isArray(declared)) {
    // 显式声明（可能是子集，也可能是扩展）。
    for (const name of declared) {
      const fromPack = byName.get(name);
      if (fromPack) {
        resolved.push(entry({ kind: "skill", name, origin: "pack", visibility: manifest.visibility ?? "private", scope: "pinned", detail: { description: fromPack.description ?? null } }));
        continue;
      }
      // 不在 pack 里 = 扩展。可能是 agent 自己的（lineage 说明来源）。
      const lineage = agent?.resources?.lineage?.skills?.[name] ?? null;
      if (lineage) {
        resolved.push(entry({ kind: "skill", name, origin: "agent", visibility: agent.visibility ?? "private", scope: "local", lineage }));
      } else {
        unresolved.push({ name, reason: UNRESOLVED_REASON.NOT_DECLARED });
      }
    }
    return { resolved, unresolved, declared: true };
  }

  // 未声明 ⇒ 整个 pack 的 skills。scoped 时也只作用于该角色，但仍然免声明。
  for (const s of packSkills) {
    if (!s?.name) continue;
    resolved.push(entry({ kind: "skill", name: s.name, origin: "pack", visibility: manifest.visibility ?? "private", scope: "pinned", detail: { description: s.description ?? null } }));
  }
  return { resolved, unresolved, declared: false };
}

// ── MCP 面（从 toolkit 支柱里取名字，不重算面）───────────────────────────────

function mcpEntries(toolkit) {
  const out = [];
  // toolkit 支柱的形状由 deriveToolkit 决定；这里只取"有哪些 server"这一层，
  // 工具细节留在 detail 里，不重算（重算就是第二次实现）。
  for (const row of asArray(toolkit?.roles)) {
    const eff = isObj(row?.effective) ? row.effective : null;
    if (!eff) continue;
    for (const serverName of Object.keys(eff)) {
      out.push(entry({ kind: "mcp", name: serverName, origin: "pack", visibility: "private", scope: "shared", detail: { tools: eff[serverName] } }));
    }
    break; // 每岗一份即可；server 集合是 pack 级的
  }
  if (!out.length && Array.isArray(toolkit?.servers)) {
    for (const s of toolkit.servers) if (s?.name) out.push(entry({ kind: "mcp", name: s.name, origin: "pack", visibility: "private", scope: "shared" }));
  }
  return out;
}

// ── 主推导 ──────────────────────────────────────────────────────────────────

/**
 * @param manifest  pack manifest
 * @param opts.scope      "pack" | "team" | "agent"（缺省 pack）
 * @param opts.memberRef  scope=team 时的成员引用（缺省 = 全部成员）
 * @param opts.agentId    scope=agent 时的角色 id
 * @param opts.toolTotals 透传给 derivePillars 的 registry 工具数（可缺）
 * @returns {{scope, pillars, skills: {resolved, unresolved, declared}, mcp, capabilities}}
 */
export function deriveCapabilities(manifest, { scope = "pack", memberRef = null, agentId = null, toolTotals = null } = {}) {
  const m = isObj(manifest) ? manifest : {};
  if (!["pack", "team", "agent"].includes(scope)) {
    return { error: `scope must be one of pack|team|agent, got ${JSON.stringify(scope)}` };
  }

  // 支柱：包装，不重写。agent 作用域把 agentId 透传下去，三者共用一份推导。
  const pillars = derivePillars(m, { agentId: scope === "agent" ? agentId : null, toolTotals });

  let skills;
  if (scope === "agent") {
    const agent = asArray(m.agents).find((a) => a?.id === agentId) ?? null;
    if (!agent) {
      // 指名了一个不存在的角色：如实报「解析不到」，MUST NOT 回落到全包
      // （那会给调用方看别人家的能力面）。
      skills = { resolved: [], unresolved: [], declared: false, error: `agent '${agentId}' not found in this pack` };
    } else {
      skills = skillEntries(m, agent);
    }
  } else if (scope === "team") {
    // 团队视角 = 各成员能力的并集视图。团队自己不持有能力（design D4）。
    const members = asArray(m.fleet?.members).filter((x) => !memberRef || x?.id === memberRef);
    const seen = new Set();
    const resolved = [];
    const unresolved = [];
    for (const mem of members) {
      const agent = asArray(m.agents).find((a) => a?.id === (mem.agentRef ?? mem.preset ?? mem.agentId)) ?? null;
      const part = skillEntries(m, agent);
      for (const e of part.resolved) { const k = `${e.kind}:${e.name}`; if (!seen.has(k)) { seen.add(k); resolved.push({ ...e, detail: { ...(e.detail ?? {}), memberRef: mem.id ?? null } }); } }
      for (const u of part.unresolved) { const k = `${u.name}:${u.reason}`; if (!seen.has(k)) { seen.add(k); unresolved.push({ ...u, memberRef: mem.id ?? null }); } }
    }
    skills = { resolved, unresolved, declared: members.length > 0 };
  } else {
    const part = skillEntries(m, null);
    skills = part;
  }

  const mcp = mcpEntries(pillars.toolkit);

  // 统一条目表：下游只需遍历这一份，不必知道 skill/mcp 的取法差异。
  const capabilities = [...skills.resolved, ...mcp];

  return { scope, pillars, skills, mcp, capabilities };
}

/** 对外投影：不可见的条目变成 opaque 占位，而不是缺席。 */
export function projectForAudience(result, { audience = "public" } = {}) {
  const visible = (v) => {
    if (audience === "owner") return true;
    if (audience === "tenant") return v === "tenant" || v === "public";
    return v === "public";
  };
  const out = [];
  for (const c of result?.capabilities ?? []) {
    if (visible(c.visibility)) out.push(c);
    else out.push({ kind: c.kind, name: null, opaque: true, note: "由提供方维护" });
  }
  return out;
}

// ── 演化策略（capability-layer 4.x）────────────────────────────────────────
//
// 策略是**声明**，不是硬编码进推导。三档：
//   manual          提议停在候选态，等人决定（现状，最保守）
//   auto-low-risk   低风险变更自动通过，高风险仍需人
//   agent-decides   agent 自己决定怎么迭代（对 scope=local 的写入直接接受）
//
// 为什么要三档而不是一档：skill-self-evolution 已实现「候选 → A/B → 人终审」，
// 但那是**一种**产品主张。做通用产品就不能把「必须人批」写死——有的部署要它，
// 有的部署要 agent 自己长。
export const EVOLUTION_MODES = Object.freeze(["manual", "auto-low-risk", "agent-decides"]);

/** 归一演化策略；未知值回落到最保守的 manual（不放宽是刻意的）。 */
export function normalizeEvolutionMode(raw) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return EVOLUTION_MODES.includes(v) ? v : "manual";
}

/**
 * 判定一次能力写入是否被接受。
 *
 * @param opts.mode       manual | auto-low-risk | agent-decides
 * @param opts.write      { kind, name, origin, scope }  —— 想写入的条目
 * @param opts.actor      "agent" | "human"
 * @param opts.risk       "low" | "high"（仅 auto-low-risk 用）
 * @returns {{accepted: boolean, reason: string, needsApproval?: boolean}}
 */
export function evaluateCapabilityWrite({ mode = "manual", write = {}, actor = "agent", risk = "high" } = {}) {
  const m = normalizeEvolutionMode(mode);
  // 硬边界：任何模式都不得覆盖 pack 声明的条目。pack 是能力的真源，
  // agent 只能新增自己那份（scope=local），不能改写提供方声明的东西。
  if (write.origin === "pack") {
    return { accepted: false, reason: "cannot overwrite a pack-declared capability — extend a local one instead" };
  }
  if (write.scope !== "local" && m === "agent-decides") {
    // agent-decides 只放开自己的本地能力；shared 是团队级一致面，不能由单个 agent 改。
    return { accepted: false, reason: "agent-decides only covers scope=local; shared/pinned need approval" };
  }
  if (actor === "human") return { accepted: true, reason: "human write" };
  if (m === "manual") return { accepted: false, needsApproval: true, reason: "manual mode: the proposal waits for a human decision" };
  if (m === "auto-low-risk") {
    return risk === "low"
      ? { accepted: true, reason: "auto-low-risk: low-risk write accepted" }
      : { accepted: false, needsApproval: true, reason: "auto-low-risk: high-risk write needs approval" };
  }
  return { accepted: true, reason: "agent-decides: the agent owns its local capabilities" };
}
