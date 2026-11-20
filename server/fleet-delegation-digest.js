// ── 委托裁决摘要 (add-deputy-decision-delegate D7 周期侧) ─────────────────────
//
// 规格：`deputy 的裁决与执行进度 SHALL 镜像进主人记忆 reference 层并按策略
// 频率汇总为摘要`，且主人「可见其裁决摘要（各裁了什么、依据）与跟踪中的问题
// 单状态（最老未决多久）」。
//
// 逐条裁决的即时镜像在 resolve 路径里（每条一页）；本模块补的是**周期摘要**
// 那一半——按策略的 digest 频率（daily/weekly）把窗口内的裁决与仍未决的跟踪
// 项合成一页 reference。页面按 fleet 固定 slug，每期覆写：主人的记忆里始终
// 是「最新一期摘要」，不会堆成一串历史页。
//
// 决定性渲染，不经 LLM：摘要不会编造，也不会因为模型抖动而变形。
// 时点事实源 = cell_settings（`delegationDigestAt:<fleetId>`），停机后下一次
// tick 立即补——与报数 digest 的补跑语义同源。

import { assessPersonalAgent } from "../lib/personal-agent-readiness.js";

const DAY = 24 * 3600_000;
export const DEPUTY_DIGEST_PERIODS = { daily: DAY, weekly: 7 * DAY };

const digestKey = (fleetId) => `delegationDigestAt:${fleetId}`;
const pad2 = (n) => String(n).padStart(2, "0");
const fmtTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** "3 小时" / "2 天" — coarse on purpose: an age, not a timestamp. */
const fmtAge = (ms) => {
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
  if (h < 48) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
};

/**
 * 确定性渲染一期摘要。空窗口返回 null（没有可说的就不写页——空摘要页比没有
 * 摘要更糟：主人会以为常务岗在岗但无事）。
 */
export function renderDeputyDigest({ db, fleet, since = 0, now = Date.now() }) {
  const all = db.listDecisions({ fleetId: fleet.id });
  const deputyId = fleet.delegationPolicy?.deputyMemberId ?? null;
  const deputy = deputyId ? db.getMember(deputyId) : null;
  const ruled = all
    .filter((d) => d.resolvedBy === "deputy" && (d.resolvedAt ?? 0) > since && (d.resolvedAt ?? 0) <= now)
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
  const tracking = all
    .filter((d) => d.route === "deputy" && d.state === "open")
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
  const executed = ruled.filter((d) => d.executedAt);
  // 被闸挡下的尝试（add-personal-mandate 4.4 / add-principal-disclosure-gate 2.4）
  // 先算：一个域整天被拦，看起来和「今天它很安静」一模一样。所以「只有被拦记录」
  // 的窗口也算有话可说——沉默的失败必须有一个数字替它说话。
  const violations = typeof db.getMandateViolations === "function" ? db.getMandateViolations() : {};
  const blocked = Object.entries(violations ?? {}).flatMap(([domain, kinds]) =>
    Object.entries(kinds ?? {}).map(([kind, count]) => ({ domain, kind, count: Number(count) || 0 })),
  ).filter((v) => v.count > 0);
  // 配置体检（2026-11-10）：就绪检查本身也要有人看才算数。只在**不可用**时进摘要
  // ——配好了还每期报一句「配置完整」是噪音；配坏了却安静，是事故。
  let readiness = null;
  try {
    if (typeof db.getFleetMandatePolicy === "function") {
      const mandate = db.getFleetMandatePolicy(fleet.id);
      const consistency = {};
      for (const d of Object.keys(mandate?.domains ?? {})) {
        consistency[d] = db.decisionConsistency?.({ fleetId: fleet.id, domain: d }) ?? null;
      }
      const r = assessPersonalAgent({
        mandate,
        domainMap: db.getPersonalDomainMap?.() ?? [],
        hasAuditor: (db.listMembers?.(fleet.id) ?? []).some((m) => m.targetKind === "auditor"),
        verdictTokenConfigured: Boolean(String(process.env.MANDATE_VERDICT_TOKEN ?? "").trim()),
        citablePrecedents: (db.listCitablePrecedents?.({ fleetId: fleet.id, limit: 500 }) ?? []).length,
        levelSamples: db.outboundLevelSamples?.() ?? {},
        consistency,
      });
      if (!r.ready) readiness = r;
    }
  } catch {
    /* 体检失败不能吞掉摘要：它是附加信息 */
  }

  // 空窗口仍然不写空页（既有合同）：配置体检虽然值得知道，但它是**常驻状态**
  // 而不是本期事件——每期重复同一句话会把「本期发生了什么」淹掉。所以体检只在
  // 本期确有内容时随附，不单独触发一期。
  if (!ruled.length && !tracking.length && !blocked.length) return null;

  const optLabel = (d) => {
    const v = d.resolution?.choice;
    if (!v) return null;
    return d.options?.find((o) => o.value === v)?.label ?? v;
  };
  const line = [];
  line.push(`常务岗裁决摘要 · ${fleet.name}`.slice(0, 120));
  line.push(`窗口: ${since ? fmtTime(since) : "首次"} → ${fmtTime(now)}${deputy ? ` · 岗位: ${deputy.title}` : ""}`);
  line.push("");
  line.push(`本期裁决 ${ruled.length} 条（已执行 ${executed.length} 条，待执行 ${ruled.length - executed.length} 条）`);
  for (const d of ruled.slice(-20)) {
    const verdict = d.resolution?.kind === "reject" ? "驳回" : `批准「${optLabel(d) ?? "?"}」`;
    line.push(`· [${d.severity}/${d.category ?? "未分类"}] ${String(d.question).slice(0, 80)} → ${verdict}`);
    if (d.rulingEvidence) line.push(`  依据: ${String(d.rulingEvidence).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (ruled.length > 20) line.push(`…（另有 ${ruled.length - 20} 条较早裁决未列出）`);
  line.push("");
  if (tracking.length) {
    const oldest = tracking[0];
    line.push(`跟踪中的问题单 ${tracking.length} 条 · 最老一条已待 ${fmtAge(now - (oldest.submittedAt ?? now))}`);
    for (const d of tracking.slice(0, 10)) {
      line.push(`· ${String(d.question).slice(0, 80)}（提交 ${fmtAge(now - (d.submittedAt ?? now))} 前）`);
    }
    if (tracking.length > 10) line.push(`…（另有 ${tracking.length - 10} 条）`);
  } else {
    line.push("跟踪中的问题单: 无");
  }
  if (readiness) {
    line.push("");
    line.push("配置体检: 还不能用");
    for (const item of readiness.items.filter((i) => !i.ok && i.severity === "blocked")) {
      line.push(`· ${item.title} —— ${item.fix}`);
    }
  }

  if (blocked.length) {
    line.push("");
    line.push("今日被闸挡下:");
    for (const v of blocked) {
      const labels = { disclose: "披露越界", read: "读取越界", quota: "额度耗尽", bypass: "旁路尝试" };
      const label = labels[v.kind] ?? v.kind;
      line.push(`· ${v.domain ?? "(未落域)"} ${label} × ${v.count}`);
    }
  }
  return line.join("\n");
}

/** Fleets whose delegation digest is due (enabled, cadence not off, period elapsed). */
export function determineDueDeputyDigests({ db, now = Date.now() } = {}) {
  const out = [];
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const policy = db.getFleetDelegationPolicy(fleet.id);
    if (!policy.enabled || !policy.deputyMemberId) continue;
    const period = DEPUTY_DIGEST_PERIODS[policy.digest];
    if (!period) continue; // "off"
    const lastAt = Number(db.getCellSetting(digestKey(fleet.id))) || 0;
    if (now - lastAt < period) continue;
    out.push({ fleet, policy, since: lastAt, now });
  }
  return out;
}

/**
 * 跑一轮到期摘要。`memoryClientFor(ownerEmail)` 由调用方注入（degrade open：
 * 拿不到客户端就跳过并**不**推进时点，下一 tick 重试——摘要丢了比迟到糟）。
 */
export async function runDueDeputyDigests({ db, memoryClientFor, now = Date.now(), log = console }) {
  const due = determineDueDeputyDigests({ db, now });
  const out = { due: due.length, written: 0, skipped: 0 };
  for (const { fleet, since } of due) {
    const body = renderDeputyDigest({ db, fleet, since, now });
    const ownerEmail = fleet.ownerEmail ?? null;
    if (!body) {
      // 空窗口：只推进时点，不写空页。
      db.setCellSetting(digestKey(fleet.id), now);
      out.skipped += 1;
      continue;
    }
    try {
      const cli = await memoryClientFor(ownerEmail);
      if (!cli) {
        out.skipped += 1;
        continue; // 不推进时点
      }
      await cli.writeReference({
        title: `常务岗裁决摘要 · ${fleet.name}`.slice(0, 120),
        summary: body,
        source_ref: `fleet:${fleet.id}:deputy-digest`,
        slug: `deputy-digest-${fleet.id}`,
        tier: "draft",
      });
      db.setCellSetting(digestKey(fleet.id), now);
      out.written += 1;
    } catch (err) {
      log.warn?.(`[deputy-digest] write failed for ${fleet.id}: ${err?.message || err}`);
      out.skipped += 1;
    }
  }
  return out;
}

export { digestKey as deputyDigestKey };
