// federated-ref.js — 数据驱动的线凭据轨（change converge-line-identity-and-keys, design D4）
//
// 一条线一行配置，不再一个模块。两种轨：
//   key        门 K（客户级）：这条线的客户钥匙。今天的唯一来源是词元账户键
//              （ciyuan-account），同一把 key 已同时喂模型车道与 wanxing-caller。
//   assertion  门 A（成员级）：平台签的断言，交线自己的兑换端点换成该线 token。
//              这一轨是**异步**的（要打 HTTP），因此不进同步的 liveToken 契约——
//              兑换入口 `exchangeAssertion()` 单独暴露，由后续任务接上。
//
// 两层开关：
//   FEDERATED_REF_ENABLED  全局（默认关）
//   每行 enabled           按线（默认 false）
// 「关闭」= 完全不参与：`entries()` 返回空数组，REFS 里不会多出条目，
// 既有解析路径一个字节都不变。这是「开关关闭时行为与现状逐字节一致」的
// 实现方式，也是回滚手段（关开关即回到手写模块）。
//
// 与既有 ref 模块同形的五件套：refName / isRef / liveToken / markInvalid /
// staleEvent；另带 connected / missingReason（credential-refs 的可选项）。

import * as ciyuanAccountCredentials from "./ciyuan-account-credentials.js";
import * as db from "./db.js";
import { ownerKey } from "./registry-credentials.js";

const TRACKS = new Set(["key", "assertion"]);

// 每行一条。新增一条线 = 加一行，不加代码。
//
// K 轨（客户级）的每一行形状完全相同，只差四个字段，所以由 `keyTrackRow()` 生成
// ——「同一实现的配置行」在这里是字面意思：lex 与 wire-customer 走同一段代码，
// 差别全在配置里（refName / line / ownTrack / 话术）。哪天要加第三条线，仍是一行。
//
// 默认全关：未打开时 `entries()` 返回空数组，REFS 不多出条目，既有解析路径一个
// 字节都不变（回滚手段就是关开关）。
function keyTrackRow({ refName, line, ownTrack, missingReason }) {
  return {
    refName,
    line,
    track: "key",
    keySource: "ciyuan-account",
    // 成员级动作的口径由线的 manifest 决定；这里只记录平台侧的期望。
    jitPolicy: "off",
    exchangeUrl: null,
    enabled: false,
    // 该线的自有常命轨：声明了它，平台凭据不可用时本 ref 的 server 才允许保留
    // （且仅当配置自身已带凭据，绝不发裸调用）——见 D5。
    ownTrack,
    staleEvent: "line_credential_stale",
    missingReason,
  };
}

export const FEDERATED_LINES = {
  // 参考线 lex：客户钥匙轨走词元；自有常命轨是 lex PAT。
  lex: keyTrackRow({
    refName: "lex",
    line: "lex",
    ownTrack: "lex-pat",
    missingReason: "connect your Ciyuan key first — no live customer key for this line",
  }),
  // 柏讯客户面（wire-customer）：同一把词元钥匙，自有常命轨是 wdk- 数据面 key
  // （`data_plane/auth.py` 双轨之一；它不承载成员身份，正好当客户级回退）。
  // 注意它和 lex 的差别只有 ownTrack 与话术——这正是把两条线并进一份配置的意义。
  "wire-customer": keyTrackRow({
    refName: "wire-customer",
    line: "wire",
    ownTrack: "wdk",
    missingReason: "connect your Ciyuan key first — no live customer key for this line",
  }),
};

export class FederatedAssertionNotConfigured extends Error {
  constructor(refName, why) {
    super(`federated assertion for "${refName}" is not configured: ${why}`);
    this.name = "FederatedAssertionNotConfigured";
    this.refName = refName;
    this.why = why;
  }
}

export function globalEnabled(env = process.env) {
  const raw = String(env.FEDERATED_REF_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function lineConfig(refName) {
  const cfg = FEDERATED_LINES[refName];
  return cfg && cfg.refName === refName ? cfg : null;
}

// 为什么这一行没生效（UI/日志用；关闭不是错误，是配置事实）。
export function degradedReason(refName, env = process.env) {
  if (!globalEnabled(env)) return "global switch off (FEDERATED_REF_ENABLED)";
  const cfg = lineConfig(refName);
  if (!cfg) return "not a federated line";
  if (cfg.enabled !== true) return "line switch off";
  return null;
}

export function isEnabled(refName, env = process.env) {
  return degradedReason(refName, env) === null;
}

// 同步解析：只有 key 轨可以同步。assertion 轨必须走 exchangeAssertion()。
function keyTokenFor(cfg, email) {
  if (cfg.track !== "key") return null;
  if (cfg.keySource !== "ciyuan-account") return null;
  return ciyuanAccountCredentials.liveToken(email) || null;
}

// 五件套条目（仅已启用的行）。直接喂给 credential-refs 的 REFS 表。
// 未知 track 的行一律不注册——配置写错时应当"不出现"，而不是变成一条
// 永远解析不出 token 的幽灵 ref（那会让 401 引导指向一个不存在的面板）。
export function entries(env = process.env) {
  return Object.values(FEDERATED_LINES)
    .filter((cfg) => isEnabled(cfg.refName, env) && TRACKS.has(cfg.track))
    .map((cfg) => ({
      refName: cfg.refName,
      federated: true,
      track: cfg.track,
      isRef: (config) => config?.credentialRef === cfg.refName,
      liveToken: (email) => keyTokenFor(cfg, email),
      markInvalid: (email) => ciyuanAccountCredentials.markStale(email),
      staleEvent: cfg.staleEvent,
      // 供 resolveCredentials 判断「缺凭据时能否保留该 server」。
      hasOwnTrack: Boolean(cfg.ownTrack),
      connected: (email) => Boolean(keyTokenFor(cfg, email)),
      missingReason: cfg.missingReason,
    }));
}

// 门 A 的兑换入口。**未接上时抛出类型化错误，不返回 null 冒充"没凭据"** ——
// 「读不到」与「没有」必须可区分（见 memory: unknown-is-not-empty）。
// 真正的实现属任务 2.1/3.x（线侧端点 + 每线签名密钥），届时只需填这里。
export async function exchangeAssertion({ refName, email, scope } = {}) {
  const cfg = lineConfig(refName);
  if (!cfg) throw new FederatedAssertionNotConfigured(refName, "not a federated line");
  if (!isEnabled(refName)) {
    throw new FederatedAssertionNotConfigured(refName, degradedReason(refName) || "disabled");
  }
  if (cfg.track !== "assertion") {
    throw new FederatedAssertionNotConfigured(refName, "this line uses the customer-key track");
  }
  if (!cfg.exchangeUrl) {
    throw new FederatedAssertionNotConfigured(refName, "identity.exchange_url not published yet");
  }
  if (!cfg.jitPolicy || cfg.jitPolicy === "off") {
    throw new FederatedAssertionNotConfigured(refName, "jit_policy is off");
  }
  // 有意留空：兑换实现（签名断言 → 线 token）在任务 2.1 落地。
  throw new FederatedAssertionNotConfigured(
    refName,
    `exchange not implemented (scope=${scope || "-"}, email=${email ? "set" : "unset"})`,
  );
}

// ── 降级记账（D5 的可证据化）────────────────────────────────────────────────
//
// 按 (人, 线) 记账，不是全局：降级是"这个人的这条线现在只能走线自有轨"，
// A 的降级不能算到 B 头上。全局计数还会让 UI 提示指向错的人。
//
// 落库而不是进程内计数：进程内计数每次滚版清零，会把"降级在持续发生"的趋势
// 擦掉（2026-11-11 教训）。用既有 kv 表、带命名空间，避免为一列数字新增迁移。
// DB 不可用 → 返回 null 表示"未知"，**不写 0**：0 是一个结论，未知不是。

const DEGRADED_KEY_PREFIX = "federated.degraded.";

function degradedKey(email, refName) {
  return `${DEGRADED_KEY_PREFIX}${ownerKey(email)}.${refName}`;
}

export function recordFederatedDegraded(refName, { servers = 1, email = null, now = new Date() } = {}) {
  if (typeof refName !== "string" || !refName) return null;
  const key = degradedKey(email, refName);
  let prev = null;
  try {
    const raw = db.getPreference(key);
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }
  const next = {
    ref: refName,
    count: (Number(prev?.count) || 0) + Math.max(1, Number(servers) || 1),
    lastAt: now.toISOString(),
  };
  try {
    db.setPreference(key, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

// 降级行。给 email → 只读该人的；不给 → 全部（运维趋势）。
// 读不到=空数组；调用方要区分"没有"与"读不到"时看自己拿到的上下文。
export function federatedDegradedStats({ email = null } = {}) {
  try {
    const all = db.getAllPreferences() || {};
    const prefix = email ? degradedKey(email, "") : DEGRADED_KEY_PREFIX;
    return Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .map(([_k, v]) => {
        try {
          const row = JSON.parse(v);
          return row && typeof row.ref === "string" ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.ref.localeCompare(b.ref));
  } catch {
    return [];
  }
}
