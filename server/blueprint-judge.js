// Blueprint assertion judge (add-blueprint-llm-assertions, design D1-D6).
//
// 模型判据的唯一实现：把一条自由文本 rubric + 已收证据交给 judge 车道，拿三态
// 判决回来，连审计件一起交回试跑报告。三条纪律写死在这里：
//
//   · 三态（D2）：pass / fail / insufficient-evidence。解析不出、超时、不可达、
//     输出不在枚举内 —— 一律 insufficient-evidence，绝不重试到绿。
//   · 禁自证（D4）：judge 车道必须与产出车道不同（同一条 lane 不给自己打分）；
//     产出车道无法解析时同样拒判。比对用既有 laneKeyFor（server/llm-lane.js），
//     不新造车道标识。
//   · 留原件（D5）：模型标识、端点摘要、提示词哈希、证据摘要、原始输出全落。
//     apiKey 只进哈希，永不落盘（沿用 lane 键的既有纪律）。
//
// 成本闸（D6）在调用方钳制（条数/字符），这里只保证「超字符即如实拒」。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { laneKeyFor } from "./llm-lane.js";
import { buildUserProviderEntries, credentialRefsForUserProviders } from "../llm-providers.js";
import { targetPaths } from "../dsh-profile.js";

export const JUDGE_VERDICTS = ["pass", "fail", "insufficient-evidence"];

export const JUDGE_LIMITS = {
  maxAssertions: Number(process.env.BLUEPRINT_JUDGE_MAX || 8),
  maxEvidenceChars: Number(process.env.BLUEPRINT_JUDGE_EVIDENCE_CHARS || 6000),
  timeoutMs: Number(process.env.BLUEPRINT_JUDGE_TIMEOUT_MS || 60_000),
};

// ── 判据结果缓存（优化①） ─────────────────────────────────────────────────
//
// 键 = provider + 模型 + promptHash。promptHash 已覆盖「提示词模板 + 判据原文 +
// 证据全文」，所以判据改一个字、证据多一行，键就变——不存在「旧判决冒充新判决」
// 的窗口；不需要额外的失效逻辑，TTL 只用来防止内存无限长。
//
// 只缓存**模型真给出的确定判决**（pass / fail）。基础设施类失败（车道不可达、
// HTTP 5xx、超时、输出不可解析）一律不缓存——那不是对这个判据的判断，缓存住
// 会把它冻成永久结论。
//
// 命中时审计件标 cached:true 并保留原始 judgedAt，另记 cacheAgeMs——事后看得
// 出「这一条不是这次判的」。
const CACHE_TTL_MS = Number(process.env.BLUEPRINT_JUDGE_CACHE_TTL_MS || 7 * 24 * 3600 * 1000);
const CACHE_MAX = Number(process.env.BLUEPRINT_JUDGE_CACHE_MAX ?? 500);
const judgeCache = new Map(); // key → { verdict, reason, audit, at, hits }

function cacheKeyFor({ providerId, model, promptHash }) {
  return `${providerId ?? "-"}|${model ?? "-"}|${promptHash}`;
}

function cacheGet(key, now) {
  const hit = judgeCache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    judgeCache.delete(key);
    return null;
  }
  // LRU touch：删了再塞回，Map 保持「最近用过的在尾」。
  judgeCache.delete(key);
  hit.hits += 1;
  judgeCache.set(key, hit);
  return hit;
}

function cachePut(key, { verdict, reason, audit }, now) {
  if (!Number.isFinite(CACHE_MAX) || CACHE_MAX <= 0) return; // 0/负 = 关闭缓存
  while (judgeCache.size >= CACHE_MAX) {
    const oldest = judgeCache.keys().next().value;
    if (oldest === undefined) break;
    judgeCache.delete(oldest);
  }
  judgeCache.set(key, { verdict, reason, audit, at: now, hits: 0 });
}

// ── 判据日配额（优化②） ───────────────────────────────────────────────────
//
// 单条试跑已有条数/字符上限，但那只是「一次」的成本闸；同一 owner 反复剪草
// 仍能无限烧。按 owner × 天（UTC）计**真实模型调用次数**：缓存命中不算、
// 基础设施失败不算（没花成钱不算用量，只是不计入——宁可少记不可多记）。
//
// 进程内计数。壹座每个 owner 在自己的 cell 进程里跑，所以这份计数天然是按
// owner 隔离的；同一进程多 owner 的情形键里也带了 owner，不会串账。
const DAILY_QUOTA_DEFAULT = 200;
// 每次调用现读 env：部署侧改值不必等进程重启才能被测试/诊断观测到，也让
// 「超限拒绝」这条分支在单测里可被真实走到。
function dailyQuota() {
  return Number(process.env.BLUEPRINT_JUDGE_DAILY_QUOTA ?? DAILY_QUOTA_DEFAULT);
}
const quotaLedger = new Map(); // `${owner}|${day}` → count

function quotaDay(now) {
  return new Date(now).toISOString().slice(0, 10); // UTC 日
}

function quotaUsed(owner, now) {
  if (!owner) return 0;
  return quotaLedger.get(`${owner}|${quotaDay(now)}`) ?? 0;
}

function quotaConsume(owner, now) {
  if (!owner) return;
  const key = `${owner}|${quotaDay(now)}`;
  quotaLedger.set(key, (quotaLedger.get(key) ?? 0) + 1);
}

// 观测口（测试与运维诊断用；不对外暴露路由）。
export function __judgeCacheStats() {
  return { size: judgeCache.size, ttlMs: CACHE_TTL_MS, max: CACHE_MAX, dailyQuota: dailyQuota() };
}
export function __judgeQuotaUsed(owner, now = Date.now()) {
  return quotaUsed(owner, now);
}
export function __resetJudgeState() {
  judgeCache.clear();
  quotaLedger.clear();
}

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

// 密钥解析（2026-10-28 生产实证）：user-route 的 key 不在 server 进程的 env 里——
// 它落在 dsh 的 .credentials.yaml（dsh-credentials-local 的 refs 段），那是给
// dsh 子进程用的，server 侧读不到 env。所以按 dsh 自己的层次来：
//   进程 env > .credentials.yaml refs > LLM_API_KEY 兜底。
// 全读不到就返回空串（判据会在调用前因无 key 而失败，如实报 insufficient）。
let credCache = null; // { at, refs } —— 文件热更新，缓存 5s
function credentialRefs(now = Date.now()) {
  if (credCache && now - credCache.at < 5000) return credCache.refs;
  let refs = {};
  try {
    const doc = loadYaml(readFileSync(targetPaths().credentials, "utf8"));
    if (doc && typeof doc === "object" && doc.refs && typeof doc.refs === "object") refs = doc.refs;
  } catch {
    refs = {};
  }
  credCache = { at: now, refs };
  return refs;
}

export function __testApiKeyFor(provider) {
  return apiKeyFor(provider);
}

// 2026-10-28 生产实证：provider 的真密钥在 credentialRefsForUserProviders()[apiKeyEnv]
// （Models 页写入的绑定），而 LLM_API_KEY 是另一套上游钥匙——两者都 30 字符但内容
// 不同，用错会 502/401。顺序：providers doc 的 refs > env[apiKeyEnv] > 凭据文件 >
// LLM_API_KEY 兜底。
function apiKeyFor(provider) {
  const envName = provider?.apiKeyEnv;
  if (envName) {
    try {
      const refs = credentialRefsForUserProviders();
      const fromDoc = refs?.[envName];
      if (fromDoc) return String(fromDoc);
    } catch {
      // doc 不可读 → 继续往下试
    }
    const fromEnv = process.env[envName];
    if (fromEnv) return String(fromEnv);
    const fromFile = credentialRefs()[envName];
    if (fromFile) return String(fromFile);
  }
  const fallback = process.env.LLM_API_KEY || credentialRefs().LLM_API_KEY || "";
  return fallback ? String(fallback) : "";
}

// ── 车道解析 ────────────────────────────────────────────────────────────────

// 可用的 judge 模型 → { providerId, baseUrl, apiKey, model, laneId }。
// 选型顺序（三层，add-blueprint-judge-model-choice D1）：蓝图 judgeModel →
// 部署默认 BLUEPRINT_JUDGE_MODEL → 名册首个；实际用源与理由落在
// judgeSource/fallbackReason（详见下方三分判据）。
//
// 两条来源（2026-10-28 生产实证）：① 部署的 env 路由 LLM_BASE_URL/LLM_API_KEY
// 是权威且总在场；② providers doc（Models 页）补充 provider 标识与更多模型。
// doc 读不到时不得让判定整体失能——回落到 env 路由。
// 三层解析（add-blueprint-judge-model-choice D1）：蓝图 judgeModel → 部署 env →
// 名册首个。回落必须留痕（judgeSource/fallbackReason），否则事后无法解释
// 「为什么这份报告用的不是我选的模型」。
export function resolveJudgeLane({ entries = null, preferredModel = null } = {}) {
  const deployDefault = (process.env.BLUEPRINT_JUDGE_MODEL || "").trim();
  const blueprintPick = (preferredModel || "").trim();
  const wanted = blueprintPick || deployDefault;
  const doc = (() => {
    try {
      return entries ?? buildUserProviderEntries();
    } catch {
      return { providers: {}, models: [] };
    }
  })();
  const hit = wanted ? doc.models?.find((m) => m.id === wanted || m.name === wanted) : null;
  // 蓝图显式选了但名册里没有：**名册本身可能不可见**（2026-10-29 生产实证——
  // cell 进程有自己的 PLATFORM_DATA_DIR，其 llm-providers.json 常为空，模型
  // 配置在网关侧）。所以只有「名册可见且确实不含」才判 unavailable；名册为空
  // 但有部署 env 路由时，照发一次、让上游如实回答（真错就是 404/502 →
  // insufficient-evidence 带原因），不因为看不见名册就整体失能。
  const rosterVisible = Array.isArray(doc.models) && doc.models.length > 0;
  if (blueprintPick && !hit && rosterVisible) {
    return {
      unavailable: true,
      requestedModel: blueprintPick,
      reason: `the blueprint's judgeModel '${blueprintPick}' is not in this deployment's model roster — pick one from the model settings page`,
    };
  }
  const model = hit || doc.models?.[0];
  const provider = model ? doc.providers?.[model.provider] : null;
  const providerBase = provider ? provider.baseURL || provider.baseUrl || "" : "";
  const willUseEnvRoute = !(model && provider && providerBase);

  // 判据来源按「最终真正用的是哪个模型」判，且理由必须说真话。
  //
  // 2026-10-30 生产实证修正：原写法把「部署默认配了、只是不在本 cell 名册」一律标成
  // fallback + 「fell back to the first listed model」。但在 cell 名册为空（生产常
  // 态：40/41 个 cell 无 llm-providers.json）时，实际走的是部署 env 路由，用的**就是
  // 那个配的模型**，根本没有「回落到别的模型」。这句理由会把读者引向错误结论
  // （以为配置没生效），也让 judge-default 端点回显骗人。
  //
  // 现在的三分：
  //   blueprint  —— 用了蓝图选的模型（无论经名册还是经部署 env 路由）
  //   deployment —— 用了部署默认的模型（同上）
  //   fallback   —— 真的没用上指定的那个（配置了但名册可见且不含 → 用了名册首个）
  let judgeSource;
  let fallbackReason = null;
  if (blueprintPick) {
    judgeSource = "blueprint";
    if (!hit && willUseEnvRoute) {
      fallbackReason = `the blueprint's judgeModel '${blueprintPick}' is not listed in this cell's llm-providers.json; routed via the deployment env route instead (normal when the cell has an empty roster)`;
    }
  } else if (deployDefault) {
    if (hit) {
      judgeSource = "deployment";
    } else if (willUseEnvRoute) {
      // 名册不可见 → 部署 env 路由用的仍是 deployDefault，配置是生效的。
      judgeSource = "deployment";
      fallbackReason = `'${deployDefault}' is not listed in this cell's llm-providers.json; routed via the deployment env route instead (normal when the cell has an empty roster)`;
    } else {
      // 名册可见且确实不含 → 真的用了名册首个，这才是 fallback。
      judgeSource = "fallback";
      fallbackReason = `deployment default '${deployDefault}' is not in this deployment's model roster; fell back to the first listed model '${model.id}'`;
    }
  } else {
    judgeSource = "fallback";
    fallbackReason = "no blueprint judgeModel and no deployment default; used the first listed model";
  }

  if (model && provider) {
    const apiKey = apiKeyFor(provider);
    const baseUrl = provider.baseURL || provider.baseUrl || "";
    if (baseUrl) {
      return {
        providerId: model.provider,
        baseUrl,
        apiKey,
        model: model.id,
        laneId: laneKeyFor({ id: model.provider, baseURL: baseUrl, apiKey }),
        judgeSource,
        fallbackReason,
      };
    }
  }

  // 回落：部署 env 路由（模型名取 BLUEPRINT_JUDGE_MODEL 或 LLM_MODEL）。
  const envBase = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const envModel = wanted || (process.env.LLM_MODEL || "").trim();
  if (!envBase || !envModel) return null;
  const apiKey = apiKeyFor({ apiKeyEnv: "LLM_API_KEY" });
  return {
    providerId: "env-route",
    baseUrl: envBase,
    apiKey,
    model: envModel,
    laneId: laneKeyFor({ id: "env-route", baseURL: envBase, apiKey }),
    judgeSource,
    fallbackReason,
  };
}

// 诊断串（no-lane 分支带出来，免得生产上只有一句"没配"看不出根因）。
function laneDiagnostics(entries) {
  const doc = (() => {
    try {
      return entries ?? buildUserProviderEntries();
    } catch (err) {
      return { error: err?.message || String(err), providers: {}, models: [] };
    }
  })();
  return JSON.stringify({
    wanted: process.env.BLUEPRINT_JUDGE_MODEL || null,
    docModels: doc.models?.length ?? 0,
    docError: doc.error ?? null,
    envBase: Boolean(process.env.LLM_BASE_URL),
    envKey: Boolean(process.env.LLM_API_KEY),
    envModel: process.env.LLM_MODEL || null,
  });
}

// 产出主体：某模型 id 落在哪条 lane、哪个 provider、模型本身叫什么。
// 解析不出返回 null（调用方据此拒判）。
export function laneForModel(modelId, { entries = null } = {}) {
  const doc = entries ?? buildUserProviderEntries();
  const model = doc.models.find((m) => m.id === modelId);
  if (!model) return null;
  const provider = doc.providers?.[model.provider];
  if (!provider) return null;
  const apiKey = apiKeyFor(provider);
  return {
    laneId: laneKeyFor({ id: model.provider, baseURL: provider.baseURL || provider.baseUrl, apiKey }),
    providerId: model.provider,
    model: model.id,
  };
}

// D4 的判定口径（2026-10-28 生产实证修正）：同一条 lane ≠ 同一个判断主体。
// 单个 provider 承载全模型名册是常态（生产：finddata-token 下 14 个模型），
// 按 lane 判会把「换一个模型来复核」全部误拒。真正要禁的是**同一个模型给自己
// 打分**，所以判据是 provider+model 双同，而非 lane 指纹相同。
export function isSelfGrading(judge, producer) {
  if (!judge || !producer) return true; // 解析不出即拒（宁可判不了，不可自评）
  // 同一模型名一律算自证（跨 provider 别名指向同一权重时同样不得自评）；
  // 否则按 provider+model 双同判。
  if (judge.model && producer.model && judge.model === producer.model) return true;
  return judge.providerId === producer.providerId && judge.model === producer.model;
}

// ── 提示词（D3 证据接地：只喂已收证据，不喂蓝图自述） ──────────────────────

export function buildJudgePrompt({ rubric, evidenceText }) {
  const system = [
    "你是验收判据的独立评审，不是这份产出的作者。",
    "只依据下面的运行证据判断判据是否满足；证据没有覆盖到的部分，判 insufficient-evidence，不要凭常识补全，也不要因为判据写得漂亮就通过。",
    "输出严格的 JSON，且只输出 JSON：",
    '{"verdict":"pass|fail|insufficient-evidence","reason":"不超过 120 字"}',
    "判定口径：pass=证据直接支持判据；fail=证据明确违反判据；insufficient-evidence=证据不足以判断（含证据为空、只沾边不直接支持）。",
  ].join("\n");
  const user = [`【判据】\n${rubric}`, `【运行证据】\n${evidenceText || "(无证据)"}`].join("\n\n");
  return { system, user };
}

// ── 判决解析（D2 三态；越界一律 insufficient-evidence） ────────────────────

// 从任意文本里取出第一个能解析成对象的 JSON 片段。
// 2026-10-29 生产实证（12 次采样）：判据模型常在本该只有 JSON 的输出尾部多吐
// 引号——`{"verdict":"pass",...}"}"`。原先取「第一个 { 到最后一个 }」会把尾部
// 垃圾一并切片，JSON.parse 失败 → 按不足证据判不绿，于是一份本该全绿的试跑
// 随机变红（实测 3/8）。改为：从第一个 { 起，逐个 } 位置**由后向前**试解析，
// 取第一个成功者。尾部垃圾不再影响判决，且仍不放宽「内容必须是 JSON 对象」。
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const endPositions = [];
  for (let i = text.length - 1; i > start; i -= 1) {
    if (text[i] === "}") endPositions.push(i);
  }
  for (const end of endPositions) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 这个 } 切出来不是合法 JSON，继续往前找
    }
  }
  return null;
}

export function parseJudgeOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { verdict: "insufficient-evidence", reason: "judge returned empty output" };
  const parsed = extractJsonObject(text);
  if (!parsed) return { verdict: "insufficient-evidence", reason: "judge output is not JSON" };
  const verdict = String(parsed?.verdict ?? "").trim();
  if (!JUDGE_VERDICTS.includes(verdict)) {
    return { verdict: "insufficient-evidence", reason: `judge returned an unknown verdict '${verdict}'` };
  }
  return { verdict, reason: typeof parsed?.reason === "string" ? parsed.reason.slice(0, 400) : "" };
}

// ── 单条判定 ────────────────────────────────────────────────────────────────

// deps: { lane, entries, fetchImpl, timeoutMs } —— 测试全注入，零真模型调用。
// 返回 { verdict, reason, audit }；audit 是报告里留档的那一份。
// ownerEmail：判据日配额的计量主体（优化②）；缺省不计配额。
export async function judgeAssertion({ assertionId, rubric, evidenceText, productionLanes = [], lane = null, judgeModel = null, ownerEmail = null, fetchImpl = fetch, timeoutMs = JUDGE_LIMITS.timeoutMs, now = Date.now() }) {
  const evidence = String(evidenceText ?? "");
  const auditBase = {
    assertionId,
    rubric: String(rubric ?? ""),
    evidenceDigest: sha(evidence),
    judgedAt: new Date().toISOString(),
  };

  if (evidence.length > JUDGE_LIMITS.maxEvidenceChars) {
    return {
      verdict: "insufficient-evidence",
      reason: `evidence exceeds the judge cap (${evidence.length} > ${JUDGE_LIMITS.maxEvidenceChars} chars) — trim the acceptance target, not the evidence`,
      audit: { ...auditBase, verdict: "insufficient-evidence", model: null, endpointDigest: null, promptHash: null, rawVerdict: null },
    };
  }

  const resolved = lane ?? resolveJudgeLane({ preferredModel: judgeModel });
  if (!resolved) {
    return {
      verdict: "insufficient-evidence",
      reason: `no judge lane is configured on this deployment (LLM route missing) ${laneDiagnostics()}`,
      audit: { ...auditBase, verdict: "insufficient-evidence", model: null, endpointDigest: null, promptHash: null, rawVerdict: null },
    };
  }
  // 蓝图选了一个名册里没有的模型 → 不静默回落，如实指名（D1/D3）。
  if (resolved.unavailable) {
    return {
      verdict: "insufficient-evidence",
      reason: resolved.reason,
      audit: {
        ...auditBase,
        verdict: "insufficient-evidence",
        model: resolved.requestedModel ?? null,
        judgeSource: "blueprint",
        judgeFallbackReason: null,
        endpointDigest: null,
        promptHash: null,
        rawVerdict: null,
      },
    };
  }

  // D4 禁自证：judge 不得是产出方的同一个模型（provider+model 双同）；产出方
  // 解析不出也拒判。同 provider 换模型是允许的——那正是「换一个模型复核」。
  const producers = productionLanes.filter(Boolean);
  if (producers.length === 0) {
    return {
      verdict: "insufficient-evidence",
      reason: "cannot resolve the producing model — refusing to let a model grade its own work",
      audit: { ...auditBase, verdict: "insufficient-evidence", model: resolved.model, endpointDigest: sha(resolved.baseUrl).slice(0, 16), promptHash: null, rawVerdict: null },
    };
  }
  const judgeSubject = { providerId: resolved.providerId, model: resolved.model };
  if (producers.some((p) => isSelfGrading(judgeSubject, p))) {
    return {
      verdict: "insufficient-evidence",
      reason: "the judge model is the same model that produced the work — self-grading is refused; pin a different BLUEPRINT_JUDGE_MODEL",
      audit: { ...auditBase, verdict: "insufficient-evidence", model: resolved.model, endpointDigest: sha(resolved.baseUrl).slice(0, 16), promptHash: null, rawVerdict: null },
    };
  }

  const { system, user } = buildJudgePrompt({ rubric, evidenceText: evidence });
  const promptHash = sha(`${system}\n${user}`).slice(0, 16);
  const audit = {
    ...auditBase,
    model: resolved.model,
    judgeSource: resolved.judgeSource ?? null,
    judgeFallbackReason: resolved.fallbackReason ?? null,
    endpointDigest: sha(resolved.baseUrl).slice(0, 16),
    promptHash,
  };

  // 缓存命中（优化①）：同一判据 + 同一证据 + 同一模型 = 同一个问题，不必再花
  // 一次调用。命中件保留原始 judgedAt 并标 cached，绝不冒充本次新判。
  const key = cacheKeyFor({ providerId: resolved.providerId, model: resolved.model, promptHash });
  const cached = cacheGet(key, now);
  if (cached) {
    return {
      verdict: cached.verdict,
      reason: cached.reason,
      audit: { ...cached.audit, cached: true, cacheAgeMs: now - cached.at, hits: cached.hits },
    };
  }

  // 日配额（优化②）：超限如实拒，不静默降级、不排队重试。
  const quota = dailyQuota();
  if (ownerEmail && quota > 0) {
    const used = quotaUsed(ownerEmail, now);
    if (used >= quota) {
      return {
        verdict: "insufficient-evidence",
        reason: `daily judge quota exhausted for ${ownerEmail} (${used}/${quota} today) — retry tomorrow or raise BLUEPRINT_JUDGE_DAILY_QUOTA`,
        audit: { ...audit, verdict: "insufficient-evidence", rawVerdict: null, quotaExceeded: true },
      };
    }
  }

  let raw = "";
  try {
    const res = await fetchImpl(`${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        verdict: "insufficient-evidence",
        reason: `judge lane HTTP ${res.status}: ${body.slice(0, 160)}`,
        // 2026-10-29 生产实证：车道抖动（429 限流 / 502-503 上游不可用）时，
        // 若只报「证据不足」，用户分不清「模型看过证据说不够」和「判据根本没
        // 跑成」。这是两种完全不同的事：前者该改证据或判据，后者该等一会儿
        // 重跑。laneError 让报告如实区分，界面据此给不同措辞。
        audit: { ...audit, verdict: "insufficient-evidence", rawVerdict: null, laneError: { status: res.status, kind: res.status === 429 ? "rate-limited" : "upstream" } },
      };
    }
    const json = await res.json().catch(() => null);
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    return {
      verdict: "insufficient-evidence",
      reason: `judge lane unreachable: ${err?.message || err}`,
      audit: { ...audit, verdict: "insufficient-evidence", rawVerdict: null, laneError: { status: null, kind: "unreachable" } },
    };
  }

  const parsed = parseJudgeOutput(raw);
  const finalAudit = { ...audit, verdict: parsed.verdict, rawVerdict: String(raw).slice(0, 2000) };
  // 只有模型真给出了确定判决（pass/fail）才记账、才缓存：evidence 不足属于
  // 「这次没判出来」，能不能判出来取决于下次的证据，冻住它等于把偶发问题
  // 变成永久结论。
  quotaConsume(ownerEmail, now);
  if (parsed.verdict === "pass" || parsed.verdict === "fail") {
    cachePut(key, { verdict: parsed.verdict, reason: parsed.reason, audit: finalAudit }, now);
  }
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    audit: finalAudit,
  };
}