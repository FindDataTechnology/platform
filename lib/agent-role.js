// ── 角色：五器官声明与状态（establish-agent-role-and-fitness-plane 5.1 / 5.3 / 5.4）─
//
// 一个角色 = 一个基因组（pack）+ 它自己长出来的状态。这个模块只管两件纯的事情：
//
//   1. **五器官声明的校验**：charter / memory / senses / objective / hands 逐项显式，
//      「空值」与「省略」必须可区分（与发布对象的九段同法：省略是忘了，空值是「本来
//      就没有」）。未知器官键点名拒绝。
//   2. **状态三态推导**：在跑且产出 / 在跑但空转 / 没跑起来。这是驾驶舱唯一的诚实
//      口径——「回合成功率 100%」不是健康，空转的岗也是 100%。
//
// 一条刻意的设计：`objective` 缺席**不**让声明无效（存量 69 份包都没有它），而是让
// 状态带一个「缺目标」的缺口标记。器官是渐进补的，判据不能一夜之间把存量判死。
//
// 与基因组的关系：`genome: {packId, version}` 是**引用**。基因组升版不触碰角色；
// 采纳/回滚是显式写这一对的两次动作（`adoptionTransition` 是它的纯运算）。

export const ORGANS = Object.freeze(["charter", "memory", "senses", "objective", "hands"]);
export const REQUIRED_ORGANS = Object.freeze(["charter", "hands"]);
export const SENSE_SURFACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ROLE_STATUSES = Object.freeze(["producing", "idle", "down"]);

/** 一个 URL/DSN/带端口的串都不能当感官面——与 store.home 只可枚举同理。 */
export function looksLikeAddress(value) {
  if (typeof value !== "string") return false;
  return /:\/\//.test(value) || /^[a-z]+:\/\//i.test(value) || /^[\w.-]+:\d+$/.test(value) || value.includes("@");
}

/**
 * 校验一份角色器官声明。返回 {ok, errors, organs, gaps}。
 *
 * `gaps` 不是错误：它列出「这个角色还缺哪些器官」。缺 objective 的存量角色照常运行，
 * 但读面必须显示它缺——不然「未声明」与「已声明且为空」就分不开了。
 */
export function validateOrgans(raw) {
  const errors = [];
  if (raw == null) return { ok: false, errors: [{ code: "organs_missing", error: "角色必须声明器官（至少 charter 与 hands）", entry: "organs" }], organs: null, gaps: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: "organs_not_object", error: "organs 必须是对象", entry: "organs" }], organs: null, gaps: [] };
  }
  for (const key of Object.keys(raw)) {
    if (!ORGANS.includes(key)) {
      errors.push({ code: "organ_unknown", error: `未知器官 '${key}'（已知：${ORGANS.join(", ")}）`, entry: `organs.${key}` });
    }
  }
  for (const key of REQUIRED_ORGANS) {
    if (!Object.hasOwn(raw, key)) {
      errors.push({
        code: "organ_missing",
        error: `缺器官 '${key}'——没有内容 MUST 写显式空值，不得省略（省略＝忘了，空值＝本来就没有）`,
        entry: `organs.${key}`,
      });
    }
  }

  const organs = {};
  // charter：为什么存在、欠谁什么。字符串（空串合法＝尚未写）。
  if (Object.hasOwn(raw, "charter")) {
    if (raw.charter !== null && typeof raw.charter !== "string") {
      errors.push({ code: "charter_not_string", error: "charter 必须是字符串或 null", entry: "organs.charter" });
    } else organs.charter = raw.charter ?? "";
  }
  // memory：沿用既有四轴 + schema 轴（agent-memory-declaration 已定型，不重造）。
  if (Object.hasOwn(raw, "memory")) {
    const m = raw.memory;
    if (m !== null && (typeof m !== "object" || Array.isArray(m))) {
      errors.push({ code: "memory_not_object", error: "memory 必须是对象或 null", entry: "organs.memory" });
    } else if (m) {
      const AXES = ["store", "read", "write", "process", "schema"];
      for (const k of Object.keys(m)) {
        if (!AXES.includes(k)) errors.push({ code: "memory_axis_unknown", error: `memory 未知轴 '${k}'（已知：${AXES.join(", ")}）`, entry: `organs.memory.${k}` });
      }
      organs.memory = m;
    } else organs.memory = null;
  }
  // senses：具名读面 + 节奏 + 什么算变化。裸 URL / 凭据逐字拒。
  if (Object.hasOwn(raw, "senses")) {
    const s = raw.senses;
    if (s !== null && !Array.isArray(s)) {
      errors.push({ code: "senses_not_array", error: "senses 必须是数组或 null", entry: "organs.senses" });
    } else if (Array.isArray(s)) {
      s.forEach((item, i) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          errors.push({ code: "sense_not_object", error: "每个感官项必须是对象", entry: `organs.senses[${i}]` });
          return;
        }
        const surface = item.surface;
        if (typeof surface !== "string" || !SENSE_SURFACE_RE.test(surface)) {
          if (looksLikeAddress(surface)) {
            errors.push({
              code: "sense_surface_is_address",
              error: `感官面 '${surface}' 是地址——只接受在册的具名读面（如 fd-info / browser-lane）；地址会让一份可分发的制品指向任意端点`,
              entry: `organs.senses[${i}].surface`,
            });
          } else {
            errors.push({ code: "sense_surface_invalid", error: `感官面 '${surface}' 不合法（须匹配 ${SENSE_SURFACE_RE}）`, entry: `organs.senses[${i}].surface` });
          }
        }
        if (!item.cadence || typeof item.cadence !== "object") {
          errors.push({ code: "sense_cadence_missing", error: "感官项必须有 cadence（多久看一次）——没有节奏的感官等于没有", entry: `organs.senses[${i}].cadence` });
        }
        if (typeof item.changeRule !== "string" || !item.changeRule.trim()) {
          errors.push({ code: "sense_change_rule_missing", error: "感官项必须有 changeRule（什么算变化）——否则每轮都是「没变化」", entry: `organs.senses[${i}].changeRule` });
        }
      });
      organs.senses = s;
    } else organs.senses = null;
  }
  // objective：它自己拥有的、跨回合连续的达成量。
  if (Object.hasOwn(raw, "objective")) {
    const o = raw.objective;
    if (o !== null && (typeof o !== "object" || Array.isArray(o))) {
      errors.push({ code: "objective_not_object", error: "objective 必须是对象或 null", entry: "organs.objective" });
    } else if (o) {
      if (typeof o.metricKey !== "string" || !o.metricKey.trim()) {
        errors.push({ code: "objective_metric_missing", error: "objective 必须给 metricKey（达成量是哪一个数）", entry: "organs.objective.metricKey" });
      }
      organs.objective = o;
    } else organs.objective = null;
  }
  // hands：收窄工具面的引用，形状与 pack 的 resources.mcpTools 同源。
  if (Object.hasOwn(raw, "hands")) {
    const h = raw.hands;
    if (h !== null && (typeof h !== "object" || Array.isArray(h))) {
      errors.push({ code: "hands_not_object", error: "hands 必须是对象或 null", entry: "organs.hands" });
    } else organs.hands = h;
  }

  const gaps = ORGANS.filter((k) => !Object.hasOwn(raw, k)).concat(ORGANS.filter((k) => Object.hasOwn(raw, k) && raw[k] === null));
  return { ok: errors.length === 0, errors, organs, gaps };
}

/**
 * 状态三态。**「回合都成功但没有任何目标相关产出」必须判空转**——这是本函数存在的
 * 全部理由（`report-contract.js` 的头部实测：516 回合 119 报数、settlement 认为 ok，
 * 而 ok 只意味着「循环结束了」）。
 *
 * @param turns   窗口内回合 [{status, startedAt}]
 * @param outputs 目标相关的产物计数（undefined = 没有目标声明，判不了产出）
 */
export function deriveRoleStatus({ turns = [], outputs = undefined, hasObjective = false }) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return { status: "down", basis: "窗口内没有任何回合——「没跑起来」不是「在跑但没说话」" };
  }
  const ok = turns.filter((t) => t.status === "ok").length;
  if (ok === 0) {
    return { status: "down", basis: `${turns.length} 个回合全部失败/中断` };
  }
  if (!hasObjective) {
    // 没有目标就判不了空转——如实说「产出这一维没有判据」，不拿回合数冒充健康。
    return { status: "producing", basis: `有 ${ok} 个成功回合；未声明 objective ⇒ 空转这一维判不了`, unjudged: "objective" };
  }
  const n = Number(outputs);
  if (!Number.isFinite(n)) {
    return { status: "producing", basis: `有 ${ok} 个成功回合；目标产出未取得 ⇒ 空转这一维判不了`, unjudged: "outputs" };
  }
  if (n <= 0) {
    return { status: "idle", basis: `${ok} 个成功回合但目标产出为 0——跑完了不等于做完了` };
  }
  return { status: "producing", basis: `${ok} 个成功回合，目标产出 ${n}` };
}

/**
 * 采纳 / 回滚的纯运算。基因组升版**不自动**改变角色；采纳是显式动作，回滚是反向动作。
 * 返回新的 genome 与一个可回滚的 before 值（调用方负责落库与写审计）。
 */
export function adoptionTransition({ current, target }) {
  const from = current ? { packId: current.packId ?? null, version: current.version ?? null } : { packId: null, version: null };
  if (!target || typeof target !== "object" || !target.packId) {
    return { ok: false, error: "target genome must carry packId" };
  }
  const to = { packId: String(target.packId), version: Number.isFinite(Number(target.version)) ? Number(target.version) : null };
  if (from.packId && from.packId !== to.packId) {
    return { ok: false, error: `不能把角色从基因组 '${from.packId}' 改挂到 '${to.packId}'——换基因组等于换一个角色，重铸而不是采纳` };
  }
  if (to.version !== null && from.version !== null && to.version === from.version) {
    return { ok: true, noop: true, genome: to, before: from };
  }
  return { ok: true, noop: false, genome: to, before: from };
}
