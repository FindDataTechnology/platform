// ── 词元能力快照客户端（ciyuan-capability-endpoint 的消费侧）────────────────
//
// 背景：`GET /v1/models` 只回答「这把 key 被允许看哪些模型」，不回答「此刻能不能服务」。
// 壹座因此自建探测（拉全量 id 逐个打 1-token 补全）。词元现已提供 key-scoped 快照
// `GET /v1/ciyuan/capabilities`，其中：
//   models.serving[]        = 可调度账号的模型映射并集（不是实时探测）
//   models.permitted_only[] = 可见但没有任何可调度账号能服务（今天白探的那一撮）
//
// 本模块只做一件事：把快照读成一个窄接口，且**任何失败都返回 null**——
// 消费方据此退回既有探测路径（契约要求：降级不得比现状更差）。
//
// 契约：paas/openspec/changes/add-ciyuan-capability-contract/specs/ciyuan-capability-endpoint/spec.md
// 实现：sub2api fork 仓 internal/lanes/capabilities.go

// 注意：路径是**相对 OpenAI 兼容 base** 的。消费方的 baseUrl 形如
// `https://token.finddatatech.cloud/v1`（已含 /v1），故此处只写 `/ciyuan/capabilities`。
// 写成 `/v1/ciyuan/capabilities` 会拼出 `/v1/v1/...` → 404 → 静默回落，快照永远不生效。
export const CAPABILITIES_PATH = "/ciyuan/capabilities";
export const CAPABILITIES_SCHEMA = "ciyuan.capabilities/v1";
// 只读、无副作用的辅助查询，比探测的 30s 短得多：它不许拖慢一次 sync。
export const CAPABILITIES_TIMEOUT_MS = 3_000;

// 关闭开关：CIYUAN_CAPABILITIES_DISCOVERY=off 时完全退回探测路径。
export function capabilitiesDiscoveryEnabled(env = process.env) {
  return String(env.CIYUAN_CAPABILITIES_DISCOVERY || "").trim().toLowerCase() !== "off";
}

function normalizeIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * 读一次能力快照。
 *
 * @returns {Promise<null | {
 *   schema: string, generatedAt: string|null, probed: boolean,
 *   serving: string[], permittedOnly: string[],
 *   lanes: Record<string, boolean|null>, media: object,
 *   limits: null | { balanceUsd: number, quotaUnlimited: boolean,
 *     keyQuotaUsd: number|null, keyQuotaUsedUsd: number|null, windowUsage: number|null },
 *   pricing: null | { peak: boolean, multiplier: number, peakEndsAt: string|null,
 *     nextOffpeakStart: string|null, nextOffpeakEnd: string|null,
 *     timezone: string|null, source: string|null, advisory: boolean },
 *   capacity: null | { model: string, sustainableRps: number|null, errorRatio: number|null,
 *     sampleActiveMinutes: number, confidence: "low"|"medium"|"high"|null,
 *     source: string|null, advisory: boolean },
 * }>} 任何失败（非 2xx / 超时 / 形状不符 / schema 不匹配 / auth none）都返回 null。
 */
export async function fetchCapabilities(baseUrl, apiKey, {
  fetchImpl = global.fetch,
  timeoutMs = CAPABILITIES_TIMEOUT_MS,
  auth = "bearer",
} = {}) {
  // 无凭据的本地模型车道没有「key 权益」概念，快照无意义。
  if (auth === "none" || !apiKey) return null;
  if (!baseUrl) return null;

  const url = String(baseUrl).replace(/\/+$/, "") + CAPABILITIES_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    // 404/501 = 旧版词元未部署该能力；503 = 网关服务未装配。两种都是「退回探测」。
    if (!res.ok) return null;
    const doc = await res.json();
    if (!doc || doc.schema !== CAPABILITIES_SCHEMA) return null;
    const models = doc.models;
    if (!models || !Array.isArray(models.serving) || !Array.isArray(models.permitted_only)) return null;

    const serving = normalizeIds(models.serving);
    const permittedOnly = normalizeIds(models.permitted_only);
    // 两个集合都空 ⇒ 快照没有信息量，等价于不可用（不拿它去裁探测集合）。
    if (serving.length === 0 && permittedOnly.length === 0) return null;

    return {
      schema: doc.schema,
      generatedAt: typeof doc.generated_at === "string" ? doc.generated_at : null,
      probed: doc.probed === true,
      serving,
      permittedOnly,
      lanes: normalizeLanes(doc.lanes),
      media: doc.media && typeof doc.media === "object" ? doc.media : {},
      limits: normalizeLimits(doc.limits),
      // 旧版词元没有这两段 ⇒ null，消费方静默省略对应展示行（ciyuan-pricing-capacity-surface）。
      pricing: normalizePricing(doc.pricing),
      capacity: normalizeCapacity(doc.capacity),
    };
  } catch {
    // 超时/网络/JSON/形状错误一律降级，不外抛。
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 车道段保留三态：true / false / null（unknown）。绝不把 null 折成 false。
function normalizeLanes(lanes) {
  const out = {};
  if (!lanes || typeof lanes !== "object") return out;
  for (const [lane, value] of Object.entries(lanes)) {
    if (value && typeof value === "object" && "available" in value) {
      out[lane] = value.available === true ? true : value.available === false ? false : null;
    }
  }
  return out;
}

// ── 峰谷价与观测吞吐（ciyuan-pricing-capacity-surface）─────────────────────
//
// 两段都只做展示与建议，**绝不参与调度决策**（契约 ciyuan-capability-endpoint 的禁止推断，
// 以及本仓 design D3「额度段是展示性事实」的同一理由）：把「读不到」做成调用前置门，会产生
// 「快照抖动 ⇒ 拒服务」的假故障，而真正的硬顶在词元侧。
//
// 归一化纪律沿用 normalizeLimits：**任一字段不可信 ⇒ 整块作废**。半个可信的倍率会诱使人拿它
// 去校准阈值——而契约明写 multiplier 是复合倍率（分组峰率 × 上游峰谷因子），不是结算倍率。
function normalizePricing(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  if (typeof pricing.peak !== "boolean") return null;
  // 生产者语义：1.0 = 低谷，> 1 = 高峰。小于 1 不在契约内 ⇒ 判为不可信，整块作废。
  if (typeof pricing.multiplier !== "number" || !Number.isFinite(pricing.multiplier) || pricing.multiplier < 1) {
    return null;
  }
  const ts = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    peak: pricing.peak,
    multiplier: pricing.multiplier,
    peakEndsAt: ts(pricing.peak_ends_at),
    nextOffpeakStart: ts(pricing.next_offpeak_start),
    nextOffpeakEnd: ts(pricing.next_offpeak_end),
    timezone: ts(pricing.timezone),
    source: ts(pricing.source),
    // 生产者恒发 true；只有明确为 true 时才把它当「已声明为建议」。
    advisory: pricing.advisory === true,
  };
}

// capacity 描述「该 key 近 7 天主跑的那一个模型」的观测值。三个数值允许为 null（样本不足），
// 但给了值却不是有限非负数就整块作废——「没观测到」与「观测到 0」是两件事。
function normalizeCapacity(cap) {
  if (!cap || typeof cap !== "object") return null;
  const model = typeof cap.model === "string" && cap.model.trim() ? cap.model.trim() : null;
  if (!model) return null;

  const optionalNum = (v) => {
    if (v === null || v === undefined) return { ok: true, value: null };
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return { ok: true, value: v };
    return { ok: false, value: null };
  };
  const rps = optionalNum(cap.sustainable_rps);
  const err = optionalNum(cap.error_ratio);
  if (!rps.ok || !err.ok) return null;

  const minutes = cap.sample_active_minutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return null;

  // confidence 缺失或不认识 ⇒ null（不伪造 "low"：那也是一个断言）。
  const confidence = ["low", "medium", "high"].includes(cap.confidence) ? cap.confidence : null;

  return {
    model,
    sustainableRps: rps.value,
    errorRatio: err.value,
    sampleActiveMinutes: Math.trunc(minutes),
    confidence,
    source: typeof cap.source === "string" && cap.source.trim() ? cap.source.trim() : null,
    advisory: cap.advisory === true,
  };
}

/**
 * 把 `pricing` 读成一句可展示的建议，并**区分「已在低谷」与「下次低谷」**。
 *
 * 生产者语义（capabilities_pricing.go 原文）：已在低谷时 `next_offpeak_start` 给的是
 * **当前这段低谷的起点**，因为调用方要问的是「什么时候能便宜地跑」，答案是「现在，直到 X 点」。
 * 所以低谷态必须用 `next_offpeak_end` 作为「直到」，绝不能把起点说成「下次低谷开始」。
 *
 * 另外：若结束时刻已过去，说明快照陈旧（或窗口刚跨过），此时不编造时段，退回 unknown。
 *
 * @returns {{state: "offpeak"|"peak"|"unknown", until: string|null, multiplier: number|null}}
 */
export function offpeakAdvisory(pricing, now = new Date()) {
  const unknown = { state: "unknown", until: null, multiplier: null };
  if (!pricing) return unknown;
  if (pricing.peak) {
    return { state: "peak", until: pricing.peakEndsAt, multiplier: pricing.multiplier };
  }
  const end = pricing.nextOffpeakEnd;
  if (end) {
    const t = Date.parse(end);
    if (Number.isFinite(t) && t <= now.getTime()) return unknown; // 窗口已过 ⇒ 不声称仍便宜
  }
  return { state: "offpeak", until: end, multiplier: pricing.multiplier };
}

// 额度段（余额 / key 额度 / 消费窗口）是**展示性事实**：只给面板看，不参与调度决策。
// 理由见 design D3——把它做成调用前置门，会产生「快照读不到 ⇒ 拒服务」的假故障，
// 而真正的硬顶在词元侧（余额耗尽不触上游）。
//
// 任一字段不可信就整块作废（返回 null ⇒ 面板显示「无数据」）：半个可信的对象会诱使人
// 把「读不到」读成「余额为零」，那正是本单要防的假读数。
function normalizeLimits(limits) {
  if (!limits || typeof limits !== "object") return null;
  const money = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

  const balance = money(limits.balance_usd);
  const unlimited = typeof limits.quota_unlimited === "boolean" ? limits.quota_unlimited : null;
  if (balance === null || unlimited === null) return null;

  // 生产端语义：key_quota=0 表示不限，靠 quota_unlimited 消歧（capabilities.go 原注释）。
  // 所以「说不限」与「给了一个正额度」必须恰好一真一假，两边同真同假都是自相矛盾 —— 作废。
  const quota = money(limits.key_quota_usd);
  const positiveQuota = quota !== null && quota > 0;
  if (unlimited === positiveQuota) return null;

  return {
    balanceUsd: balance,
    quotaUnlimited: unlimited,
    keyQuotaUsd: unlimited ? null : quota,
    keyQuotaUsedUsd: money(limits.key_quota_used_usd),
    windowUsage: money(limits.window_usage),
  };
}

/**
 * 用快照决定「要探测哪些 id」。
 *
 * 关键取舍：快照**不替代**探测，只缩小探测集合。
 *  - serving 非空 → 只探 serving（permitted_only 已被词元判定为无可调度账号，探了也是白探）
 *  - serving 为空但有 permitted_only → 仍探全体（可能是账号刚上线，快照未刷新）
 *  - 快照不可用 → 返回 null，调用方回落到 /models 全量探测
 *
 * @param {{serving: string[], permittedOnly: string[]}} snapshot
 * @param {string[]} fallbackIds 快照不可用时的全量 id（通常来自 /models）
 */
export function planProbeSet(snapshot, fallbackIds = []) {
  if (!snapshot) return { ids: fallbackIds, source: "models" };
  const probe = snapshot.serving.length > 0
    ? [...snapshot.serving]
    : [...snapshot.serving, ...snapshot.permittedOnly];
  if (probe.length === 0) return { ids: fallbackIds, source: "models" };
  return {
    ids: probe,
    source: "capabilities",
    skipped: snapshot.serving.length > 0 ? snapshot.permittedOnly : [],
  };
}
