// routes/ciyuan-account.js — bind a user's 词元 account without pasting a key
// (ciyuan-account-lane, design D2/D8/D9).
//
// connect: the user types their 词元 email + password; the server logs in
// server-to-server, mints a key through 词元's key API, stores ONLY the minted
// key (ciyuan-account-credentials), and lets the password and login token die
// with this request — they are never persisted, logged, or echoed. Then the
// cell's dsh credential store is rewritten so the next model request bills the
// user's own account (hosted cells only; see dsh-profile ensureCredentialsStore).
// test: probes 词元 with the stored key (200 heals / 401 flips stale).
// disconnect: drops the local key (the 词元-side key stays; the card says so).
//
// ⚠️ 为什么这里没有「一键 OIDC 授权」：词元的 OIDC 把 redirect_uri **写死**回它
// 自己的 callback（/api/v1/auth/oauth/oidc/callback），授权码在它自己的前端
// （OidcCallbackView）里就被 pending/exchange 消费掉了，平台拿不到。
// 要改这一点需要词元侧开放第三方可兑换流或允许自定义 redirect_uri。
// 实测证据（含 302 URL 原文）见 openspec/changes/ciyuan-account-oidc-bind 的 design。
// 客户想「不给密码」时走设置页的「已有调用键？直接粘贴」——那条路平台全程不接触密码。

import { createHash } from "node:crypto";
import * as ciyuanAccount from "../../ciyuan-account-credentials.js";
import { fetchCapabilities, offpeakAdvisory } from "../../lib/ciyuan-capabilities.js";
import { FORM_SHARED, deploymentForm, fallsBackOnStale, modelLaneOwner } from "../../lib/deployment-form.js";

const DEFAULT_API_BASE = "https://token.finddatatech.cloud";
const DEFAULT_GROUP_ID = 3; // same group as the deployment key (design D3)
const UPSTREAM_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

function apiBase() {
  return String(process.env.CIYUAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function mintGroupId() {
  const n = Number.parseInt(String(process.env.CIYUAN_MINT_GROUP_ID ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GROUP_ID;
}

function identity(req) {
  return req.ssoUser || req.user || null;
}

function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

// 模型车道的形态判定。**判据是部署归属，不是宿主形态**——同一进程形态在两种产品里
// 含义不同：桌面版单进程 = 安装方自己用（不该被覆盖），机房版单进程 = 一客户一实例
// （该覆盖）。见 lib/deployment-form.js 与 openspec/changes/single-tenant-model-lane。
function modelLaneForm(ctx) {
  return deploymentForm(envOf(ctx));
}

function envOf(ctx) {
  return ctx.env ?? process.env;
}

function connectionPayload(ctx, email) {
  return { ...ciyuanAccount.status(email), modelLaneForm: modelLaneForm(ctx) };
}

// ── 额度与车道的软读（ciyuan-consumer-surface 2.2）──────────────────────────
//
// 设置页是低频页面，但**词元抖动不该让页面报错**：读不到就如实说「无数据」并带原因，
// 绝不把 null 折成 0 元或「全部车道不可用」——契约见
// openspec/changes/ciyuan-consumer-surface/specs/ciyuan-line-metering/spec.md。
//
// 额度只做展示，不做调用前置门（design D3）：真正的硬顶在词元侧（余额耗尽不触上游）。
const ENTITLEMENT_OK_TTL_MS = 60_000;
const ENTITLEMENT_FAIL_TTL_MS = 15_000; // 失败缓存短一些：词元恢复后页面很快跟上
const ENTITLEMENT_CACHE_MAX = 500;
const entitlementCache = new Map();

/**
 * 读一次该用户的额度/车道快照。
 *
 * 返回的 `unavailableReason` 只有三类，且是**诚实的单一类别**：客户端契约把所有失败
 * （404 旧版词元 / 超时 / 形状不符）都折成 null，所以这里不去猜是哪一种——猜出来的
 * 精度是假的。面板只需回答「有没有数据」。
 */
async function readEntitlement(email) {
  const key = ciyuanAccount.liveToken(email) ?? ciyuanAccount.storedKeyForProbe(email);
  if (!key) {
    return { readAt: null, limits: null, lanes: null, models: null, unavailableReason: "no_key" };
  }

  const snap = await fetchCapabilities(`${apiBase()}/v1`, key);
  if (!snap) {
    console.warn("[ciyuan-account] entitlement read degraded (capabilities unavailable)");
    return { readAt: null, limits: null, lanes: null, models: null, unavailableReason: "capabilities_unavailable" };
  }

  const lanes = Object.keys(snap.lanes).length ? snap.lanes : null;
  return {
    readAt: new Date().toISOString(),
    generatedAt: snap.generatedAt,
    limits: snap.limits,
    lanes,
    models: { serving: snap.serving.length, permittedOnly: snap.permittedOnly.length },
    // 峰谷价与观测吞吐：同样只做展示，不作准入闸门（ciyuan-pricing-capacity-surface）。
    // 旧版词元没有这两段 ⇒ null，面板静默省略对应行。
    pricing: snap.pricing,
    capacity: snap.capacity,
    // 「已在低谷」与「下次低谷」的判定放服务端做一次：它要拿服务端时钟判窗口有没有过期，
    // 而面板只负责选文案——同一规则写两份迟早分叉。
    offpeak: offpeakAdvisory(snap.pricing),
    // 有任一项事实就不算「无数据」——只按 limits/lanes 判会把能显示的行一起标成 no_data。
    unavailableReason: snap.limits || lanes || snap.pricing || snap.capacity ? null : "no_data",
  };
}

async function entitlementFor(email) {
  // 不因 email 为空就放弃：`status()` 与 `liveToken()` 都把空身份归一到 MACHINE_OWNER_KEY
  // （auth-off 的单租户部署就是这个形态）。早返 null 会让那种部署里卡片显示「已连接」
  // 却永远没有额度——e2e 的 hermetic 运行正是这么暴露出来的。
  const cacheKey = email ?? "__machine__";
  const hit = entitlementCache.get(cacheKey);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const value = await readEntitlement(email);
  const ttl = value.unavailableReason ? ENTITLEMENT_FAIL_TTL_MS : ENTITLEMENT_OK_TTL_MS;
  if (entitlementCache.size >= ENTITLEMENT_CACHE_MAX) entitlementCache.clear();
  entitlementCache.set(cacheKey, { at: Date.now(), ttl, value });
  return value;
}

// 测试接缝：缓存按 email 键控，同一条测试文件会用同一个身份反复请求。
export function __resetEntitlementCache() {
  entitlementCache.clear();
}

// Rewrite the cell's dsh credential store so the override (or its removal)
// reaches the next LLM request. Failure here must not undo a stored binding —
// the card still reports the truth and the next store write catches up.
async function rewriteModelLane(ctx, bindingEmail = null, { explicitDisconnect = false } = {}) {
  try {
    const form = modelLaneForm(ctx);
    // 共享形态不碰共享凭据文件（D6 的守卫，本 change 未放松）
    if (form === FORM_SHARED) return;
    // 谁是这个实例的「主人」：cell 取 CELL_USER_EMAIL，单租户按 D2 三级解析
    const owner = modelLaneOwner(envOf(ctx), form, bindingEmail);
    const dshProfile = await import("../../dsh-profile.js");
    await dshProfile.ensureCredentialsStore({
      cellOwnerEmail: owner,
      // 单租户：客户 key **被动失效**时移除词元 refs，不回落部署 key（design D3）。
      // 但**主动断开**是用户意图，不是故障——那时候恢复种子是对的，否则客户断开后
      // 会得到一个既没有自己 key、也没有任何 key 的实例。
      denySeedFallback: !fallsBackOnStale(form) && !explicitDisconnect,
    });
  } catch (e) {
    console.warn(`[ciyuan-account] credential store rewrite failed: ${e?.message || e}`);
  }
}

function reapplyMcp(ctx, user) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, user?.groups ?? null, user?.email ?? null)
    ?.catch((e) => console.warn(`[ciyuan-account] profile update failed: ${e.message}`));
}

// yizuo-<8 hex of the platform identity>-<yyyymmdd>: recognisable in the 词元
// console, carries no email.
export function keyNameFor(email, now = new Date()) {
  const hash = createHash("sha256").update(String(email ?? "owner")).digest("hex").slice(0, 8);
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `yizuo-${hash}-${d}`;
}

// Pull the plaintext key out of the mint response without assuming one exact
// envelope: the first `sk-` string among the usual field names wins.
export function extractMintedKey(body) {
  const data = body && typeof body === "object" ? (body.data && typeof body.data === "object" ? body.data : body) : null;
  if (!data) return null;
  for (const field of ["key", "api_key", "apiKey", "token", "value"]) {
    const v = data[field];
    if (typeof v === "string" && v.startsWith("sk-")) return { key: v, id: data.id ?? null };
  }
  return null;
}

function extractAccessToken(body) {
  const data = body && typeof body === "object" ? (body.data && typeof body.data === "object" ? body.data : body) : null;
  if (!data) return null;
  for (const field of ["access_token", "accessToken", "token"]) {
    if (typeof data[field] === "string" && data[field]) return data[field];
  }
  return null;
}

// Upstream error text for the user: short, never echoes request material.
function upstreamReason(body, fallback) {
  const msg = body && typeof body === "object" ? body.message || body.error || body.msg : null;
  const text = typeof msg === "string" ? msg : fallback;
  return String(text).replace(/sk-[A-Za-z0-9_-]+/g, "sk-…").slice(0, 160);
}

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, ok: r.ok, body };
}

export function registerCiyuanAccountRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/ciyuan-account/connection", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "词元 account binding is disabled (database unavailable)" });
    }
    const email = identity(req)?.email ?? null;
    const payload = connectionPayload(ctx, email);
    // 只有已绑定（或待重连）才去读额度；未绑定不该触发一次上游调用。
    const entitlement = payload.connected || payload.stale ? await entitlementFor(email) : null;
    res.json({ ...payload, entitlement });
  });

  app.post("/api/ciyuan-account/connect", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "词元 account binding is disabled (database unavailable)" });
    }
    const { email: ciyuanEmail, password } = req.body || {};
    if (typeof ciyuanEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ciyuanEmail.trim()) || ciyuanEmail.length > 254) {
      return res.status(400).json({ error: "Enter the email of your 词元 account" });
    }
    if (typeof password !== "string" || !password || password.length > 256) {
      return res.status(400).json({ error: "Enter your 词元 password" });
    }
    const user = identity(req);
    const base = apiBase();

    // 1. login — the only place the password is used; it is not retained.
    let accessToken = null;
    try {
      const login = await fetchJson(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ciyuanEmail.trim(), password }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!login.ok) {
        if (login.status === 400 || login.status === 401 || login.status === 403) {
          return res.status(401).json({ error: "词元 login failed — check the email and password of your 词元 account" });
        }
        return res.status(502).json({ error: `词元 login service answered ${login.status}: ${upstreamReason(login.body, "unavailable")}` });
      }
      accessToken = extractAccessToken(login.body);
      if (!accessToken) {
        return res.status(502).json({ error: "词元 login answered without a session token" });
      }
    } catch (e) {
      // Network/timeout: state untouched, readable reason, no request material.
      return res.status(502).json({ error: `词元 login service unreachable (${e?.name === "TimeoutError" ? "timed out" : "network error"})` });
    }

    // 2. mint — a fresh key named for this platform identity, in the configured group.
    const groupId = mintGroupId();
    const keyName = keyNameFor(user?.email ?? null);
    let minted = null;
    try {
      const mint = await fetchJson(`${base}/api/v1/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: keyName, group_id: groupId }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!mint.ok) {
        return res.status(502).json({ error: `词元 refused to mint a key (${mint.status}): ${upstreamReason(mint.body, "no detail")}` });
      }
      minted = extractMintedKey(mint.body);
      if (!minted) {
        return res.status(502).json({ error: "词元 minted a key but the response carried no sk- value" });
      }
    } catch (e) {
      return res.status(502).json({ error: `词元 key service unreachable (${e?.name === "TimeoutError" ? "timed out" : "network error"})` });
    } finally {
      accessToken = null;
    }

    // 3. store only the minted key, then let the model lane pick it up.
    const status = ciyuanAccount.store({
      email: user?.email ?? null,
      token: minted.key,
      keyId: minted.id,
      keyName,
      groupId,
      ciyuanEmail: ciyuanEmail.trim(),
    });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    console.log(`[ciyuan-account] bound (key ${keyName}, group ${groupId}) — value redacted`);
    await rewriteModelLane(ctx, user?.email ?? null);
    reapplyMcp(ctx, user);
    res.json(connectionPayload(ctx, user?.email ?? null));
  });

  // Probe 词元 with the stored key. 200 heals a stale row; 401/403 flips stale
  // and falls the model lane back to the deployment seed; anything else (network,
  // 5xx) leaves state alone — a flapping upstream must not unbind anyone.
  app.post("/api/ciyuan-account/test", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const user = identity(req);
    const email = user?.email ?? null;
    const row = ciyuanAccount.status(email);
    if (!row.connected && !row.stale) {
      return res.status(400).json({ error: "No 词元 account is bound yet", ...connectionPayload(ctx, email) });
    }
    // A stale row still has its key; probe with it so a healed upstream heals the row.
    const key = ciyuanAccount.liveToken(email) ?? ciyuanAccount.storedKeyForProbe(email);
    if (!key) {
      return res.status(400).json({ error: "No key available to test", ...connectionPayload(ctx, email) });
    }
    let outcome;
    try {
      const r = await fetch(`${apiBase()}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (r.ok) {
        if (ciyuanAccount.markHealthy(email)) {
          await rewriteModelLane(ctx, email);
          reapplyMcp(ctx, user);
        }
        outcome = { reachable: true, detail: "HTTP 200" };
      } else if (r.status === 401 || r.status === 403) {
        if (ciyuanAccount.markStale(email)) {
          await rewriteModelLane(ctx, email);
          reapplyMcp(ctx, user);
        }
        outcome = { reachable: true, detail: `HTTP ${r.status} — key rejected` };
      } else {
        outcome = { reachable: true, detail: `HTTP ${r.status} — state unchanged` };
      }
    } catch (e) {
      outcome = { reachable: false, detail: e?.name === "TimeoutError" ? "timed out" : "network error" };
    }
    res.json({ ...connectionPayload(ctx, email), probe: outcome });
  });

  app.delete("/api/ciyuan-account", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const user = identity(req);
    ciyuanAccount.disconnect(user?.email ?? null);
    await rewriteModelLane(ctx, user?.email ?? null, { explicitDisconnect: true });
    reapplyMcp(ctx, user);
    res.json(connectionPayload(ctx, user?.email ?? null));
  });
}
