// ── 报数 digest (fleet-owner-iteration) ──────────────────────────────────────
//
// 决定性渲染 + 账内 unread 投递：digest 是 fleet 既有读面在订阅期内的投影
// （open 拍板计数 + 每岗最近报数槽位 + 未报岗名单 + 花销 24h), 不经任何
// LLM 回合——「内容渲染不得编造」的纪律, 与 scheduled-task-notifications 的
// 「session last-updated 派生 unread」语义同源。
//
// 投递通道 = 订阅专属会话（fleet-digest:<subId>, owner=订阅者）：写入一条
// assistant 消息即抬 session updatedAt, 客户端的「未看=unread」派生自然生效。
// 停机补跑 = last_run_at/last_sent_at 事实源 + 由调用者按周期 tick (boot
// 即挂, 进程宕机后下一次 tick 立即补)。

import crypto from "node:crypto";

const DAY = 24 * 3600_000;
export const DIGEST_PERIODS = { daily: DAY, weekly: 7 * DAY };

const SLOT_VALUE_MAX = 24;
const DELTA_INLINE_MAX = 16;

// 报数合约里的指标值是 {value, delta} 形状，不是裸标量（近 7 天实测 316 条只有
// `{"value":N}` 与 `{"delta","value"}` 两种）。直接 String() 化就是 `[object
// Object]`——2026-11-13 首次真投递时**每一个槽位**都是这样，订阅了等于没订。
//
// 呈现口径：值本身 + 短 delta（括号）；长句 delta 不进 digest（它留在报数车道，
// digest 只做可扫读摘要）。未知对象形状宁可留空，也不落 `[object Object]`。
export function formatMetricValue(raw) {
  let value = raw;
  let delta = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    value = raw.value;
    delta = typeof raw.delta === "string" ? raw.delta.trim() : null;
  }
  let text;
  if (value == null) text = "";
  else if (Array.isArray(value)) text = value.map((v) => (v == null ? "" : String(v))).filter(Boolean).join("/");
  else if (typeof value === "object") text = "";
  else text = String(value);
  text = text.slice(0, SLOT_VALUE_MAX);
  if (delta && delta.length <= DELTA_INLINE_MAX) text += `（${delta}）`;
  return text;
}

export function renderDigest({ db, fleet, now = Date.now() }) {
  const members = db.listMembers(fleet.id);
  const openDecisions = db.listDecisions({ fleetId: fleet.id, state: "open" });
  const spend = db.spendProjection(fleet.id, { now });
  const line = [];
  line.push(`集群日报 · ${fleet.name}`.slice(0, 120));
  line.push(`拍板待决: ${openDecisions.length} 项 · 集群状态: ${fleet.state}`);
  const missing = [];
  for (const m of members) {
    const latest = db.latestReportFor(m.id);
    // metrics 落库为 {key: value} 平面；槽位 label 从成员声明映射（无声明就
    // 直落 key — 与报数合约一致, 不虚构标签）。
    const slotLabels = Object.fromEntries((m.kpiSlots ?? []).map((s) => [s.key, s.label ?? s.key]));
    const entries = Object.entries(latest?.metrics ?? {}).slice(0, 4);
    const metrics = entries.map(([k, v]) => `${slotLabels[k] ?? k}=${formatMetricValue(v)}`).join("，");
    if (!latest || (latest.createdAt ?? 0) < now - 26 * 3600_000) missing.push(m.title);
    if (metrics) line.push(`· ${m.title}: ${metrics}`);
    else line.push(`· ${m.title}: 本期未报`);
  }
  if (missing.length) line.push(`未报岗位: ${missing.join("、")}`);
  const t24 = spend.windows["24h"];
  line.push(`近24h: ${t24.turns} 回合/${t24.runs} 实例${t24.usageInput != null ? ` · token ${t24.usageInput}/${t24.usageOutput}` : " (usage 未记录)"}`);
  return line.join("\n");
}

export function determineDueSubscriptions({ db, now = Date.now() } = {}) {
  return db
    .listDigestSubscriptions({})
    .filter((sub) => {
      const period = DIGEST_PERIODS[sub.cadence] ?? DAY;
      return !sub.lastRunAt || now - sub.lastRunAt >= period;
    });
}

// 执行一轮到期订阅的渲染+投递。chat-history 由调用方注入（recordMessage/
// createSession 接口与我们登记的 owner-user 口径对齐）。
export async function runDueDigests({ db, chatHistory, now = Date.now(), log = console }) {
  const due = determineDueSubscriptions({ db, now });
  const out = { due: due.length, sent: 0, skipped: 0 };
  for (const sub of due) {
    const fleet = db.getFleet(sub.fleetId);
    if (!fleet || fleet.ownerEmail !== sub.ownerEmail || fleet.state === "archived") {
      db.touchDigestRun(sub.id, { at: now });
      out.skipped += 1;
      continue;
    }
    const body = renderDigest({ db, fleet, now });
    const sessionId = `fleet-digest:${sub.id}`;
    try {
      // 标题：recordMessage 只从 user 角色派生标题，assistant 一律 "New chat"——
      // 11 条 digest 在侧栏并排全叫 New chat，主人分不清哪支队伍（2026-11-13 实测）。
      // 只在**新建**时写，主人改过的标题不被后来的周期覆盖。
      const existed = Boolean(chatHistory.sessionExists?.(sessionId));
      chatHistory.createSession?.(sessionId, sub.ownerEmail);
      chatHistory.recordMessage(sessionId, "assistant", body, undefined, sub.ownerEmail);
      if (!existed) {
        try {
          chatHistory.setTitle?.(sessionId, body.split("\n")[0].trim());
        } catch {
          // 标题是呈现层的便利，写不进去不影响 digest 本身已经落账。
        }
      }
      db.touchDigestRun(sub.id, { at: now, sent: true });
      out.sent += 1;
    } catch (err) {
      log.warn?.(`[fleet-digest] deliver failed for ${sub.id}: ${err?.message || err}`);
      db.touchDigestRun(sub.id, { at: now });
    }
  }
  return out;
}

// Boot hook: 每 tick 检查一次到期 (默认 60s, 停机补跑由 lastRunAt 承担)。
export function startDigestRunner({ db, chatHistory, intervalMs = 60_000, log = console }) {
  const timer = setInterval(() => {
    runDueDigests({ db, chatHistory, log }).catch((e) => log.warn?.(`[fleet-digest] tick failed: ${e?.message || e}`));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export const digestSubId = () => `dg_${crypto.randomBytes(8).toString("base64url")}`;
