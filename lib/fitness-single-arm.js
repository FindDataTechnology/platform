// ── 单臂试跑判词（establish-agent-role-and-fitness-plane 8.5）──────────────────
//
// 客户面唯一被允许的「自己试一次」：装上包、跑一轮、看它跑不跑得起来、产出像不像样。
//
// 三条红线（`pack-fitness-publication` spec）：
//   1. **不输出裁决**。这里没有 retain/merge/retire 的出口——单臂没有对照，任何胜负
//      结论都是无源之水。函数的返回值里连 `verdict` 这个字段都不存在，不是靠注释约定。
//   2. **跑不起来 ≠ 这份包不好**。失败必须分类到「你这里缺什么」（凭据/网络/配额/
//      上游/装配），因为同一个包在别的环境里可能是好的。
//   3. **判词只有两轴**：健康（runs / blocked）与产出（decent / thin / unjudged）。
//      「产出像样」用确定性数（回合成功、有报数、有产物引用），不调模型。

export const HEALTH = Object.freeze(["runs", "blocked"]);
export const OUTPUT = Object.freeze(["decent", "thin", "unjudged"]);

/**
 * 失败分类。**顺序有意义**：先判「环境缺什么」，再判「包/装配有什么问题」——
 * 因为环境缺失是客户能自己修的，装配问题才需要我们看。
 */
export const BLOCK_REASONS = Object.freeze({
  credentials: "你这里缺凭据（把该服务接上再试）",
  network: "网络不可达（试试换网络或检查出口）",
  quota: "配额用尽（等额度恢复或升级）",
  upstream: "上游服务报错（不是你的问题，过一会儿再试）",
  config: "参数被拒（检查你填的设置）",
  assembly: "装不起来（包的装配有问题，需要报给我们）",
  unknown: "原因不明（把这段输出发给我们）",
});

/** 从一条错误文本归类。认不准就 unknown——猜到比认不出更坏。 */
export function classifyFailure(text) {
  const s = String(text ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/401|403|unauthor|invalid[_ ]?token|credential|api[_ ]?key|凭据|未授权/.test(s)) return "credentials";
  if (/enotfound|econnrefused|etimedout|timeout|network|unreachable|dns|网络|超时/.test(s)) return "network";
  if (/429|quota|rate.?limit|budget|配额/.test(s)) return "quota";
  if (/50[0-4]|upstream|bad gateway|上游/.test(s)) return "upstream";
  if (/400|422|invalid|参数|schema/.test(s)) return "config";
  if (/provision|materializ|装配|no such preset|pack not found/.test(s)) return "assembly";
  return "unknown";
}

/**
 * 单臂判词。
 *
 * @param rounds  [{ status, reportLanded?, artifactRefs? }] 本轮各岗的回合结果
 * @param errors  装配/点火错误（非空即 blocked，且分类决定措辞）
 */
export function judgeSingleArm({ rounds = [], errors = [] } = {}) {
  const errList = (Array.isArray(errors) ? errors : [errors]).filter(Boolean).map(String);
  if (errList.length) {
    const reason = classifyFailure(errList.join(" | "));
    return {
      health: "blocked",
      output: "unjudged",
      reason,
      // 措辞是给客户看的：说清「在你这儿没跑起来」，不说「这包不好」。
      message: BLOCK_REASONS[reason],
      evidence: { errors: errList.slice(0, 5) },
    };
  }
  const list = Array.isArray(rounds) ? rounds : [];
  if (!list.length) {
    return {
      health: "blocked",
      output: "unjudged",
      reason: "assembly",
      message: "一个回合都没起来——装上了但没有可跑的任务（这属于装配问题）",
      evidence: { errors: [] },
    };
  }
  const ok = list.filter((r) => r?.status === "ok").length;
  if (ok === 0) {
    const joined = list.map((r) => r?.error).filter(Boolean).join(" | ");
    const reason = classifyFailure(joined);
    return { health: "blocked", output: "unjudged", reason, message: BLOCK_REASONS[reason], evidence: { rounds: list.length } };
  }
  const reported = list.filter((r) => r?.reportLanded === true).length;
  const artifacts = list.reduce((n, r) => n + (Array.isArray(r?.artifactRefs) ? r.artifactRefs.length : 0), 0);
  // 「像样」= 至少一个回合成功，且**至少留下了一样可查的东西**（一份报数或一份产物）。
  // 只有成功回合、什么都没留下，按 thin 处理——那正是「跑完了不等于做完了」。
  const output = reported > 0 || artifacts > 0 ? "decent" : "thin";
  return {
    health: "runs",
    output,
    reason: null,
    message: output === "decent" ? `跑起来了，留下了 ${reported} 份报数 / ${artifacts} 份产物` : "跑起来了，但没有留下任何可查的报数或产物",
    evidence: { rounds: list.length, ok, reported, artifacts },
  };
}

/** 结果里绝不允许出现胜负/裁决字段——发布面据此渲染。 */
export function assertionNoVerdict(result) {
  const forbidden = ["verdict", "winner", "retain", "retire", "merge", "score"];
  return forbidden.every((k) => !Object.hasOwn(result ?? {}, k));
}
