// ── Fleet input policy (add-input-request-cards, design D8) ──────────────────
//
// 团队与岗位两级声明「这个岗位可以问哪类卡、一回合能问几次、多久没人答怎么
// 收尾、谁能答」。解析是**逐字段**合并（member → fleet → 系统默认），不是整份
// 覆盖：岗位只想改超时，不该顺手把舰队声明的 allowedTypes 清掉。
//
// 表态与既有 nullable 配置列一致：两层都空 = 有效策略为空 = 走内核默认 =
// 与引入本能力之前字节一致。
//
// 归属（哪个岗位在问）由服务端解析，不信子进程自报：会话 → 最近的回合事件
// （member_turn_events）→ 岗位 → 舰队。没有回合事件的普通会话没有归属，按
// 「未配置策略」处理——不猜。

import { getFleetDatabase } from "./routes/fleets-db.js";
export const INPUT_POLICY_KEYS = Object.freeze([
  "allowedTypes",
  "perTurnQuota",
  "timeoutSec",
  "onUnattended",
  "answerableBy",
]);

const CARD_TYPES = new Set(["form", "confirm", "choice"]);
const UNATTENDED = new Set(["wait", "default", "abort", "escalate"]);
const ANSWERABLE = new Set(["owner", "any"]);

/**
 * Normalize one declared layer. Unknown keys are dropped; invalid values are
 * dropped rather than repaired (a policy that silently becomes something else
 * is worse than no policy — the request then falls back to the next layer).
 */
export function parseInputPolicy(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const out = {};
  if (Array.isArray(doc.allowedTypes)) {
    const types = doc.allowedTypes.filter((t) => CARD_TYPES.has(t));
    if (types.length > 0) out.allowedTypes = [...new Set(types)];
  }
  const quota = Number(doc.perTurnQuota);
  if (Number.isFinite(quota) && quota > 0) out.perTurnQuota = Math.round(quota);
  const timeout = Number(doc.timeoutSec);
  if (Number.isFinite(timeout) && timeout > 0) out.timeoutSec = Math.round(timeout);
  if (UNATTENDED.has(doc.onUnattended)) out.onUnattended = doc.onUnattended;
  if (ANSWERABLE.has(doc.answerableBy)) out.answerableBy = doc.answerableBy;
  return Object.keys(out).length > 0 ? out : null;
}

/** Per-field merge: member wins, then fleet, then nothing (caller defaults). */
export function resolveInputPolicy({ member = null, fleet = null } = {}) {
  const m = parseInputPolicy(member);
  const f = parseInputPolicy(fleet);
  if (!m && !f) return null;
  return { ...(f ?? {}), ...(m ?? {}) };
}

/**
 * Which post is asking? The session's most recent fleet turn event names the
 * member; the member row names the fleet. No event = not a fleet session.
 *
 * NOTE: `member_turn_events` lives in the FLEET database (`fleets.db`), not the
 * app database — querying `getDb()` here silently returns nothing, which would
 * read as "no post declares a policy" for every fleet session.
 */
export function attributeInputRequestSession(sessionId, fleetDb = null) {
  if (!sessionId) return null;
  try {
    const db = fleetDb ?? getFleetDatabase().db;
    const row = db
      .prepare(
        "SELECT fleet_id, member_id FROM member_turn_events WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(String(sessionId));
    if (!row) return null;
    return { fleetId: row.fleet_id, memberId: row.member_id };
  } catch {
    return null;
  }
}

/** The effective policy for one asking session, or null when nothing declares one. */
export function inputPolicyForSession(sessionId) {
  const attribution = attributeInputRequestSession(sessionId);
  if (!attribution) return { attribution: null, policy: null };
  try {
    const fdb = getFleetDatabase();
    const fleet = fdb.getFleet(attribution.fleetId);
    const member = fdb.getMember(attribution.memberId);
    return {
      attribution,
      policy: resolveInputPolicy({ member: member?.inputPolicy, fleet: fleet?.inputPolicy }),
    };
  } catch {
    return { attribution, policy: null };
  }
}

/**
 * Per-turn quota. The turn id comes from the platform's live turn state; when
 * it is absent (a lane that never entered the turn registry) the check counts
 * the session's pending requests instead — a runaway loop is still stopped, and
 * an already-answered request never blocks a legitimate second ask.
 */
export function checkPerTurnQuota(db, { sessionId, turnId, quota }) {
  if (!quota || !sessionId) return { ok: true, used: 0 };
  const row = turnId
    ? db
        .prepare("SELECT COUNT(*) AS n FROM input_requests WHERE session_id = ? AND turn_id = ?")
        .get(String(sessionId), String(turnId))
    : db
        .prepare("SELECT COUNT(*) AS n FROM input_requests WHERE session_id = ? AND state = 'pending'")
        .get(String(sessionId));
  const used = row?.n ?? 0;
  return used >= quota
    ? { ok: false, used, quota, ...(turnId ? { turnId } : {}) }
    : { ok: true, used };
}
