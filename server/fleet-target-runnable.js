// ── 一个岗位能不能造出一条回合：判据本体（唯一一份） ─────────────────────
//
// fix-dispatch-to-parked-post 在派发面加了这个判据（`/api/fleets/:id/dispatch`）。
// 归档时清点九处建回合的调用点，发现同一个洞还有四个入口：接棒边、事件唤醒、
// 拍板送达、委托-persona。产线实证（cell 1da519d4c1c0bf89，member_turn_events 8062 行）：
// `source=manual, edge_kind=handoff, "Unknown agent preset: policy-brief"` 9 条，
// 最近 2026-11-14T01:43:39Z —— 接棒车道一直能把活派给一个 roster 里没有的岗位。
//
// 这个模块只有「问一句」这一件事，解析器由调用方注入：
//   · 纯函数、零依赖 ⇒ 五个入口共用一份，谁都不会分叉出一套自己的判据；
//   · `resolve` 是必需参数（不给默认值）⇒ 忘了注入就是调用即抛，
//     而不是静默放行——静默放行正是这次要修的病本身。
//
// 工具岗与集群岗豁免的理由写在派发面（add-tool-posts / Guard 4），这里原样保留：
// 工具的能力面在运行期如实判定，集群岗在「无手动车道」处已被拒。
export function targetRunnable(target, resolve) {
  if (!target) return { ok: false, error: "the target post no longer exists" };
  if (target.targetKind === "cluster" || target.targetKind === "tool") return { ok: true };
  if (typeof resolve !== "function") {
    throw new TypeError("targetRunnable needs a resolver — a missing resolver must fail loudly, not allow the turn");
  }
  const r = resolve({ targetKind: target.targetKind, targetId: target.targetId });
  if (r?.alive === true) return { ok: true };
  const who = target.title ? `post '${target.title}'` : `${target.targetKind} '${target.targetId}'`;
  return {
    ok: false,
    error: `${who} is parked: its target ${target.targetKind}/${target.targetId} no longer exists — restaff it before dispatching`,
  };
}
