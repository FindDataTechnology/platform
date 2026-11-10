// ── observe-tap（add-platform-guaranteed-capture D2）─────────────────────────
//
// 平台担保捕获的三面共享件：chat（finishTurn 双载体）、bot（handleMessage 结
// 算）、智语房间（room-router 三分支）在回合收尾调 observeTurnTap()，向
// fd-memory /observe 报一条 turn_outcome L0 observation。全路径 fire-and-
// forget：不 await 进回合关键路径、永不 throw、失败即丢——记忆捕获永不阻塞
// 回合（与舰队捕获 fail-open 同契）。
//
// 归属：
//   chat / bot   → owner person 根 default project（u/<email>）
//   智语房间     → 房主 person 根的房间名下 project（与集群 cron 的 room-id
//                  project 同构；房间内容绝不进任何成员的个人 default 根——
//                  与「分身不带主人私人记忆进空间」互为镜像）
// 回滚杆：CELL_MEMORY_OBSERVE_TAP=0 全关三面（零请求，字节等同回滚）。

import { cellMemoryConfig, personTokenFor, observeFireAndForget, newIdempotencyKey } from "@finddatatechnology/yongyi-client";

const TITLE_CAP = 80;
const BODY_CAP = 4000;

function clip(s, cap) {
  const t = String(s ?? "").trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

export function observeTapConfig(env = process.env) {
  if (env.CELL_MEMORY_OBSERVE_TAP === "0") return null;
  const cfg = cellMemoryConfig(env);
  if (!cfg) return null;
  return cfg;
}

// 令牌铸造缓存（进程内，同 owner 只铸一次；失败计一次丢弃，下回合重试）。
// fetchImpl 贯通铸造与投递两链（测试缝）。
const tokenCache = new Map();
async function tokenFor(cfg, ownerEmail, fetchImpl) {
  const hit = tokenCache.get(ownerEmail);
  if (hit) return hit;
  const tok = await personTokenFor(cfg, ownerEmail, fetchImpl);
  tokenCache.set(ownerEmail, tok);
  return tok;
}

/**
 * 回合收尾捕获：三面共享入口。任何参数缺失、开关关闭、令牌铸造失败、投递失
 * 败都静默丢弃（warn 一行 + 计数），绝不影响调用方的回合收尾。
 *
 * @param {object} arg
 * @param {string} arg.ownerEmail   归属人根（chat/bot=回合 owner；智语=房主）
 * @param {"chat"|"bot"|"zhiyu"} arg.lane
 * @param {string} arg.sessionId    会话标识（chat=ws session；bot=平台 chatKey
 *                                  派生；智语=房间上下文 id）
 * @param {string} [arg.agentId]    执行 agent（智语=member.ref）
 * @param {"ok"|"error"|"aborted"} arg.outcome
 * @param {number} [arg.durationMs]
 * @param {string} [arg.title]      入站消息原料（截断纪律在函数内执行）
 * @param {string} [arg.body]       final text 摘要原料（截断纪律在函数内执行）
 * @param {string} [arg.roomId]     智语房间 id（有值即落房主根房间 project）
 */
export function observeTurnTap(arg, env = process.env, fetchImpl = undefined) {
  try {
    const cfg = observeTapConfig(env);
    if (!cfg || !arg?.ownerEmail || !arg.lane || !arg.sessionId) return;
    const outcome = arg.outcome ?? "ok";
    const metadata = {
      lane: arg.lane,
      sessionId: String(arg.sessionId).slice(0, 128),
      ...(arg.agentId ? { agentId: String(arg.agentId).slice(0, 128) } : {}),
      outcome,
      ...(Number.isFinite(arg.durationMs) ? { durationMs: Math.round(arg.durationMs) } : {}),
      // Caller-supplied factual flags (e.g. {unbilled:"no_billing_key"}). Kept
      // shallow and string/number-only so a caller cannot smuggle a payload.
      ...(arg.detail && typeof arg.detail === "object"
        ? {
            detail: Object.fromEntries(
              Object.entries(arg.detail)
                .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
                .slice(0, 8)
                .map(([k, v]) => [String(k).slice(0, 32), typeof v === "string" ? v.slice(0, 120) : v]),
            ),
          }
        : {}),
    };
    const event = {
      url: cfg.url,
      type: "turn_outcome",
      idempotencyKey: newIdempotencyKey(),
      title: clip(arg.title, TITLE_CAP) || `回合收尾（${arg.lane}/${outcome}）`,
      // fd-memory /observe 有 body_required 校验（空 body 400 丢弃）——无
      // final text 的回合（passed/流缓冲溢出清空等）用最小过程叙事保落底。
      body: clip(arg.body, BODY_CAP) || `回合收尾（${arg.lane}/${outcome}），无 final text`,
      subject: arg.agentId ? String(arg.agentId).slice(0, 128) : undefined,
      harness: "yizuo",
      metadata,
      ...(arg.roomId ? { project: `room-${String(arg.roomId).slice(0, 96)}` } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    };
    void tokenFor(cfg, arg.ownerEmail, fetchImpl)
      .then((token) => {
        observeFireAndForget({ ...event, token, env });
      })
      .catch((err) => {
        // 铸造失败：静默丢弃（fail-open），warn 一行即全部可观测。
        console.warn(`[observe-tap] ${arg.lane} capture dropped (token): ${err?.message || err}`);
      });
  } catch (err) {
    console.warn(`[observe-tap] capture dropped: ${err?.message || err}`);
  }
}

export function resetObserveTapTokenCache() {
  tokenCache.clear();
}
