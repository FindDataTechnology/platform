// ── 迭代回路 (fleet-owner-iteration) ────────────────────────────────────────
//
// 设计落字（design D1/D2）：
//   * 审批单 = 决策项 (decision_items, item_type='config-change')，类型键 +
//     detail JSON 承载 diff/摘要/回调结果 —— 唯一通道，不另建审批表。
//   * 铸版链 = 白名单编排既有段：live 集群白名单导出 → 预检 (validate-only)
//     → 以既有发布链上架新主版本；失败如实挂轴、从失败环重试。
//   * 「批准前零生效」与「回调失败不翻盘」：proposal 落 open 决策项 +
//     iteration(state='proposed')；批准回调铸造——抛错记 axis，结论不回归。
//
// 提交链运输: HTTP 穿操作者会话路线（cookie 或 x-facet-user 转发），与人工
// 在市场界面发布的语义逐字节一致 — publish auth/gates 一个不跳。

import crypto from "node:crypto";
import { exportFleetToTemplate } from "./fleet-template.js";

export const ITERATION_STATES = ["proposed", "approved", "casting", "publishing", "published", "failed"];

const mint = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("base64url")}`;

// 提议入口：当前 live 集群的一次「配置改动主张」入决策车道。changeDoc 是
// 【服务端为准的语义负载】：{ summary, changes, diff? }——changes 是白名单
// 键集（模板结构/参数槽值）；diff 若在场，是调用者(架构师)已经跑过的
// dry-run 报告。无效负载在函数外面就被路由拒收（提议主体必填）。
export function createConfigChangeProposal({ db, fleet, ownerEmail, changeDoc }) {
  const summary = typeof changeDoc?.summary === "string" ? changeDoc.summary.trim() : "";
  if (!summary) return { ok: false, error: "summary required" };
  const changes = changeDoc.changes && typeof changeDoc.changes === "object" && !Array.isArray(changeDoc.changes) ? changeDoc.changes : null;
  if (!changes || Object.keys(changes).length === 0) {
    return { ok: false, error: "changes must be a non-empty object (white-listed keys)" };
  }
  const question = `迭代提议 · ${summary}`.slice(0, 200);
  const item = db.appendDecision({
    id: mint("d_iter"),
    fleetId: fleet.id,
    memberId: "", // 提案主体是主人(集群层), 不挂在某个岗位上
    question,
    options: [{ value: "approve" }, { value: "reject" }],
    severity: "normal",
    recommendation: summary,
    itemType: "config-change",
    detail: {
      summary,
      changes,
      ...(changeDoc.diff ? { diff: changeDoc.diff } : {}),
      proposedBy: ownerEmail,
    },
  });
  const packId = fleet.sourceTemplate?.packId;
  const iteration = db.appendIteration({
    id: mint("it"),
    fleetId: fleet.id,
    packId: packId ?? "",
    decisionId: item.id,
    state: "proposed",
    notes: summary,
    createdBy: ownerEmail,
  });
  return { ok: true, decision: item, iteration };
}

// 批准的回调 (design D1)：decision 路由的 approve 分支把控制交到这里；
// decision 的 approved 状态是先入痕的 — 抛错↑挂 axis, 不回调结论。
// publishFn 由路由层注入（附体凭据: 正处批准动作的那个 owner session 走市场口径）。
export async function runIterationCast({ db, iteration, ownerEmail: _ownerEmail, installFn, publishFn, validateFn, log = console }) {
  // 幂等锚: 已 published 的或 casting/publishing 里的不重入（决策路由的
  // 「首次决议胜」语义后, 回调只点一次火）。
  if (["published", "casting", "publishing"].includes(iteration.state)) return iteration;
  db.transitionIteration(iteration.id, { state: "approved" });

  const fleet = db.getFleet(iteration.fleetId);
  if (!fleet) return db.transitionIteration(iteration.id, { state: "failed", axis: "fleet-missing", note: "fleet no longer exists" });
  const packId = iteration.packId || fleet.sourceTemplate?.packId;
  if (!packId) return db.transitionIteration(iteration.id, { state: "failed", axis: "source-template-missing", note: "no source template on this fleet" });

  try {
    // 1. 白名单导出: live 成员骨架 (参数槽 substitution 已烙印在成员值里,
    //    export 只担保结构白名单与编排段 — 运行时痕迹不入单)。
    const members = db.listMembers(fleet.id);
    const exported = exportFleetToTemplate(fleet, members);

    // 2. 装 manifest 骨架: 继承来源 installed pack (版本基线), 换 fleet 段。
    const installed = installFn ? await installFn(packId) : null;
    if (!installed?.manifest) {
      return db.transitionIteration(iteration.id, { state: "failed", axis: "source-manifest-missing", note: `pack '${packId}' not installed here` });
    }
    const manifest = {
      ...installed.manifest,
      name: installed.manifest.name ?? fleet.name,
      fleet: exported.fleet,
      notes: iteration.notes ?? `iterate from v${fleet.sourceTemplate?.version ?? "?"}`,
    };
    delete manifest.visibility; // 可见性=包级属性, 版本循环不携带

    // 3. 预检 (validate-only): 提前把失败铸在环首, 不浪费发布预算。
    if (validateFn) {
      const verdict = await validateFn({ packId, manifest });
      if (verdict && verdict.valid === false) {
        const first = verdict.errors?.[0]?.error ?? verdict.errors?.[0] ?? "validate failed";
        return db.transitionIteration(iteration.id, { state: "failed", axis: "validate", note: String(first).slice(0, 300) });
      }
    }

    // 4. 发布: 同 packId → 新主版本 (包装版语义, 与人工发布同缝)。
    db.transitionIteration(iteration.id, { state: "casting" });
    const published = await publishFn({ packId, manifest });
    if (!published || published.error) {
      return db.transitionIteration(iteration.id, { state: "failed", axis: "publish", note: String(published?.error ?? "publish rejected").slice(0, 300) });
    }
    db.transitionIteration(iteration.id, { state: "publishing" });
    return db.transitionIteration(iteration.id, {
      state: "published",
      publishedVersion: published.version ?? null,
      axis: null,
      note: "",
    });
  } catch (err) {
    log.warn?.(`[fleet-iteration] cast failed for ${iteration.id}: ${err?.message || err}`);
    return db.transitionIteration(iteration.id, { state: "failed", axis: "unhandled", note: String(err?.message || err).slice(0, 300) });
  }
}

// 失败后从失败环重试 (不重跑整链: 状态行是幂等锚, 仅 casting/publishing 里
// 因外部失败的「in-flight」允许重入同一动作)。
export async function retryIterationCast({ db, iterationId, ownerEmail, installFn, publishFn, validateFn, log }) {
  const it0 = db.getIteration(iterationId);
  if (!it0) return { ok: false, error: "iteration not found" };
  if (it0.state === "published") return { ok: true, iteration: it0, already: true };
  if (it0.state === "proposed") return { ok: false, error: "not approved yet — the decision is the gate" };
  const it = await runIterationCast({ db, iteration: it0, ownerEmail, installFn, publishFn, validateFn, log });
  return { ok: it.state !== "failed", iteration: it };
}
