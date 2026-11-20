// ── 启动期作业自愈（fix-fleet-boot-reconcile）────────────────────────────────
//
// 舰队岗位的定时作业只有两个物化时机：写舰队的路由（建/改/归档成员）与
// catalog onChange（persona 增减）。**启动时没有**。于是任何「进程停机期间被创建」
// 或「带外写入创建」的岗位，行在了、读面正常、面板显示有节奏，却永远没有作业，
// 也就永远不出现回合——一种完全静默的死岗。
//
// 实测 2026-11-13：给「个人幕僚团」建常务岗（成员行 cadence=20 * * * *、
// 委托策略 deputyMemberId 已生效），读面一切正常，但它不会跑；同一时刻全库
// 有 32 条决策已按策略路由给 deputy / deputy-triage，而 9 支舰队根本没有代理人。
//
// 因此 boot 收口处对全部舰队做一次收敛（reconcileFleet 幂等：无变化时零动作，
// 且归档舰队不物化）。失败按舰队隔离，一支坏不拖垮整轮。

import { reconcileAllFleets } from "./fleet-reconcile.js";

/**
 * Converge every fleet once at boot. Skips (does not throw) when the task engine
 * is still starting: `cron.addJob` needs the engine, and boot ordering is the
 * caller's to guarantee — a self-heal must never be the thing that breaks boot.
 *
 * @returns {Promise<Array<{fleetId: string} & Record<string, unknown>>>} per-fleet actions
 */
export async function bootReconcileFleets({
  db,
  cronApi,
  resolveTarget,
  rosterPresetId = (id) => id,
  isEngineReady = null,
  log = console,
} = {}) {
  const ready = typeof isEngineReady === "function" ? isEngineReady() : true;
  if (!ready) {
    log.warn?.("[fleets] boot reconcile skipped — task engine not initialized yet");
    return [];
  }
  try {
    // One catalog snapshot for the whole pass: resolving against the live
    // catalog re-merges it per member (~30ms each), which for a large account
    // would block the event loop right when boot is still settling.
    const results = await reconcileAllFleets({ db, cronApi, resolveTarget, rosterPresetId });
    const touched = results.filter((r) => r.created?.length || r.updated?.length || r.removed?.length);
    if (touched.length) {
      const created = touched.reduce((n, r) => n + (r.created?.length ?? 0), 0);
      const removed = touched.reduce((n, r) => n + (r.removed?.length ?? 0), 0);
      log.log?.(`[fleets] boot reconcile: ${touched.length} fleet(s) converged (created ${created}, removed ${removed})`);
    }
    const failed = results.filter((r) => r.error);
    for (const f of failed) log.warn?.(`[fleets] boot reconcile failed for ${f.fleetId}: ${f.error}`);
    return results;
  } catch (err) {
    // A converge pass must never keep the platform from finishing boot.
    log.warn?.(`[fleets] boot reconcile failed: ${err?.message || err}`);
    return [];
  }
}
