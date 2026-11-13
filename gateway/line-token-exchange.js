// ── 门 K 换票：词元客户钥匙 → 短命线级 JWT（change converge-line-identity-and-keys 7.1）
//
// 客户拿词元 `sk-` 打网关，网关验证后换发 `aud`=目标线、带 `source` 标记、
// `exp` ≤10 分钟的 JWT；线侧只做离线 JWKS 验签，不回调平台、不逐请求问计费
// （design D2 K2）。这样线侧多出来的只有一个公钥，独立性反而更强。
//
// 三个刻意的选择：
//
//   1. **关闭 = 路由不存在，不是分支里的 404**。全局开关 `LINE_EXCHANGE_ENABLED`
//      未开、或该线不在 `LINE_EXCHANGE_LINES` 里，`registerLineExchange()` 一条
//      路由都不挂。现行网关按设计剥掉调用方 `Authorization`（只中继
//      airegistry-tools），改成发币是行为变更——"关闭时行为与现状逐字节一致"
//      只能靠不注册来保证，靠 `if (!enabled) return 404` 保证不了（路径一旦存在，
//      探测面、日志面、超时面全变了）。
//
//   2. **每线一把钥，JWKS 按线发布**。共用一把钥时，泄漏的 lex 私钥照样能签出
//      `aud=wire` 的令牌被 wire 接受——per-line 密钥就只剩轮换便利，泄漏面回到
//      全局（design 的配套前提）。`jwksDocument(line)` 只出该线那一把。
//
//   3. **钥匙校验复用既有的那份客户端**（`lib/sub2api-admin.js` 的
//      findUserByKey + probeKeyLiveness），不另接一次 sub2api。同一份凭据两个
//      读者必须共用解析——分开写就会有一边慢慢漂成另一套语义。
//
// 不在这里做的事（有意）：
//   * 不存 jti、不防重放。签出来的令牌是给线用的，一次性由线自己的重放台账裁决
//     （lex 的 `console_assertion_replays` 就是这么做的）；网关存一份只会多一处
//     要清理的状态。
//   * 不做按线授权集合的判定。客户钥匙有效但未获该线授权是 **403**，这个结论只有
//     线知道（它才持有授权数据）；网关在这里只回答"这把钥匙是谁"。
//
// 判定与签发都是纯函数（可注入 verifier 与时钟），`gateway/index.js` 里只留薄接线
// ——这个仓反复吃过的亏：判定绿了不等于接缝真的调了它。

import { createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

export const LINE_EXCHANGE_PATH_PREFIX = "/api/lines";
export const LINE_EXCHANGE_MAX_TTL_SECONDS = 600;
export const LINE_EXCHANGE_DEFAULT_TTL_SECONDS = 600;
export const LINE_EXCHANGE_SCOPES = ["line:read", "line:write"];

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function pemFromEnv(raw) {
  const text = String(raw ?? "");
  if (!text) return "";
  // 部署侧 env 常把换行写成字面量 \n（Secret 单行注入）；两种都收。
  return text.includes("\\n") ? text.replace(/\\n/g, "\n") : text;
}

export function globalEnabled(env = process.env) {
  const raw = String(env.LINE_EXCHANGE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

// 每线开关是显式名单，不是"配了钥匙就算开"：钥匙漏进环境不该顺带把出口打开。
export function enabledLines(env = process.env) {
  if (!globalEnabled(env)) return [];
  return String(env.LINE_EXCHANGE_LINES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function lineEnabled(line, env = process.env) {
  return enabledLines(env).includes(String(line ?? "").trim().toLowerCase());
}

function keyEnvName(line, suffix) {
  return `LINE_EXCHANGE_${suffix}_${String(line).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * 该线的签发材料。缺私钥 → 视为未配置（不签发，也不假装成"开了但签不出"）。
 * @returns {{kid:string, privateKey:string, ttlSeconds:number} | null}
 */
export function lineSigningKey(line, env = process.env) {
  const name = String(line ?? "").trim().toLowerCase();
  if (!name) return null;
  const privateKey = pemFromEnv(env[keyEnvName(name, "KEY")]);
  if (!privateKey) return null;
  const ttlRaw = Number(env[keyEnvName(name, "TTL_SECONDS")] ?? env.LINE_EXCHANGE_TTL_SECONDS ?? LINE_EXCHANGE_DEFAULT_TTL_SECONDS);
  const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(Math.floor(ttlRaw), LINE_EXCHANGE_MAX_TTL_SECONDS) : LINE_EXCHANGE_DEFAULT_TTL_SECONDS;
  return {
    kid: String(env[keyEnvName(name, "KID")] ?? `${name}-1`),
    privateKey,
    ttlSeconds: ttl,
  };
}

/** 该线的公钥 JWKS（线侧离线验签用）。未配置 → 空 keys，不抛。 */
export function jwksDocument(line, env = process.env) {
  const material = lineSigningKey(line, env);
  if (!material) return { keys: [] };
  let jwk;
  try {
    jwk = createPublicKey(material.privateKey).export({ format: "jwk" });
  } catch {
    return { keys: [] };
  }
  return { keys: [{ ...jwk, kid: material.kid, use: "sig", alg: "ES256" }] };
}

/**
 * 签一枚线级令牌。claims 的键就是线侧要断言的键，不再由各线自定义。
 * @returns {string} compact JWT
 */
export function mintLineToken({
  line,
  subject,
  email = null,
  scope = "line:read",
  kid,
  privateKey,
  ttlSeconds = LINE_EXCHANGE_DEFAULT_TTL_SECONDS,
  issuer = "https://mcp.finddatatech.cloud",
  now = Date.now(),
} = {}) {
  const ttl = Math.min(Math.max(1, Math.floor(Number(ttlSeconds) || LINE_EXCHANGE_DEFAULT_TTL_SECONDS)), LINE_EXCHANGE_MAX_TTL_SECONDS);
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const payload = b64url(
    JSON.stringify({
      iss: issuer,
      sub: String(subject),
      ...(email ? { email } : {}),
      aud: line,
      // source 是"这次换票为哪条线发的"：审计与计量按它归属，线侧也能据此拒
      // 别的线换来的令牌（即使签名与 aud 都合法）。
      source: line,
      scope,
      iat,
      exp: iat + ttl,
      jti: randomUUID(),
    }),
  );
  const data = `${header}.${payload}`;
  const signature = cryptoSign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(signature)}`;
}

/** 测试/线侧自检用：按同一契约验一枚令牌（生产里这一步在线侧做）。 */
export function verifyLineToken(token, { publicKey, line, now = Date.now() } = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "token_malformed" };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "token_malformed" };
  }
  const okSig = cryptoVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  if (!okSig) return { ok: false, reason: "bad_signature" };
  if (line && claims.aud !== line) return { ok: false, reason: "wrong_audience" };
  if (line && claims.source !== line) return { ok: false, reason: "wrong_source" };
  if (!(Number(claims.exp) > Math.floor(now / 1000))) return { ok: false, reason: "expired" };
  if (Number(claims.exp) - Number(claims.iat) > LINE_EXCHANGE_MAX_TTL_SECONDS) return { ok: false, reason: "ttl_too_long" };
  return { ok: true, header, claims };
}

/**
 * 换票判定（纯函数，不碰网络：verifier 由调用方注入）。
 *
 * @param {object} input
 * @param {string} input.line            目标线（路由参数）
 * @param {string} input.authorization   原始 Authorization 头
 * @param {object} input.env             环境（测试注入）
 * @param {Function} input.verifyCaller  async (key) => {ok, userId, email, reason, status}
 * @param {number} [input.now]
 * @returns {Promise<{status:number, error?:string, token?:string, claims?:object}>}
 */
export async function decideLineExchange({ line, authorization, env = process.env, verifyCaller, now = Date.now() } = {}) {
  const name = String(line ?? "").trim().toLowerCase();
  if (!lineEnabled(name, env)) return { status: 404, error: "not_found" };

  const material = lineSigningKey(name, env);
  // 开了开关却没给私钥：503 而不是 500——这是配置缺失，运维可修，不是调用方的错。
  if (!material) return { status: 503, error: "line_signing_key_missing" };

  const provided = String(authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return { status: 401, error: "missing_credential" };

  let verdict;
  try {
    verdict = await verifyCaller(provided);
  } catch (e) {
    return { status: 503, error: "billing_plane_unreachable", detail: e?.message };
  }
  // 计费面不可用必须是 503：401 会让调用方以为钥匙坏了去重贴，而真正的原因
  // 是"现在没人能回答这把钥匙是谁"。
  if (verdict?.status === 503 || verdict?.degraded) return { status: 503, error: "billing_plane_degraded" };
  if (!verdict?.ok) return { status: 401, error: verdict?.reason || "invalid_credential" };

  const token = mintLineToken({
    line: name,
    subject: verdict.userId ?? verdict.email ?? "unknown",
    email: verdict.email ?? null,
    scope: "line:read",
    kid: material.kid,
    privateKey: material.privateKey,
    ttlSeconds: material.ttlSeconds,
    now,
  });
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return { status: 200, token, claims };
}

/**
 * 接线：只在全局开 + 该线在名单里时挂路由。返回挂上的路由数（0 = 完全没有
 * 新出口，`/api/lines/*` 与改动前一样是兜底路由处理）。
 *
 * 路由：`POST /api/lines/:line/token`（换票）、`GET /api/lines/:line/jwks.json`
 * （该线公钥）。两者都只对该线存在——另一条线打同一路径走兜底。
 */
export function registerLineExchange(app, { verifyCaller, env = process.env, now = () => Date.now() } = {}) {
  const lines = enabledLines(env);
  if (!lines.length) return 0;
  let mounted = 0;
  for (const line of lines) {
    app.post(`${LINE_EXCHANGE_PATH_PREFIX}/${line}/token`, async (req, res) => {
      const verdict = await decideLineExchange({
        line,
        authorization: req.headers?.authorization,
        env,
        verifyCaller,
        now: now(),
      });
      if (verdict.status !== 200) return res.status(verdict.status).json({ error: verdict.error });
      // token_type=Bearer：线侧把它当 Bearer 用，和 sk- 同一个位置，客户端不用改。
      return res.json({ token: verdict.token, token_type: "Bearer", expires_at: verdict.claims.exp });
    });
    app.get(`${LINE_EXCHANGE_PATH_PREFIX}/${line}/jwks.json`, (_req, res) => {
      res.setHeader("cache-control", "public, max-age=300");
      res.json(jwksDocument(line, env));
    });
    mounted += 2;
  }
  return mounted;
}

/** 自检/测试用：造一对 P-256 钥匙（生产钥来自 Secret，绝不在此生成）。 */
export function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey,
  };
}
