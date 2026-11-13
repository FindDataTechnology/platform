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
