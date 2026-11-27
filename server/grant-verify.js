// ── 委托 Grant 离线验签（establish-ai-native-ecommerce-stack 4.1）─────────────
//
// 网关替 ERP 转发时要从 Grant 里取出 `jti` 与 `budget.amount` 注入给下游。
// **必须自己验签**，不能只解码：`jwtPayload` 那种 base64 解析谁都能伪造，
// 拿它当权威等于让任何登录用户自称「预算 100 万」。
//
// 为什么在网关侧验而不在 ERP 侧验：
//   - ERP 是 Python，验签要么引 PyJWT（已装）+ 取 JWKS（要出网），要么把
//     JWKS 打进包；网关是 Node，`crypto.verify` 原生支持 Ed25519，零依赖。
//   - 一次验签，下游只读头——ERP 侧不必再信一遍（它的信任边界已经是网关了）。
//
// JWKS 来源：registry 的 `/api/jwks`（按 kid 返回，轮转时同 aud 给新旧两枚）。
// 缓存 5 分钟：轮转后最长 5 分钟生效，比每次请求打 registry 便宜得多。

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const JWKS_TTL_MS = 5 * 60 * 1000;
//: kid → { key, fetchedAt }
const _keyCache = new Map();
let _lastFetchAt = 0;

function b64urlToBuf(s) {
  return Buffer.from(String(s), "base64url");
}

/** 把 JWK（OKP / Ed25519）转成 Node KeyObject。 */
function jwkToKey(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) return null;
  try {
    return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
  } catch {
    return null;
  }
}

/**
 * 取某个 kid 的公钥。命中缓存直接用；缓存过期则整批刷新一次。
 * 刷新失败**不清空旧键**（宁可多活 5 分钟，也不让一次网络抖动把整条链打死），
 * 但也**不放行未验签**的 token。
 */
async function publicKeyFor(kid, { jwksUrl, fetchImpl, warn }) {
  const now = Date.now();
  const hit = _keyCache.get(kid);
  if (hit && now - hit.fetchedAt < JWKS_TTL_MS) return hit.key;
  if (jwksUrl && (now - _lastFetchAt >= JWKS_TTL_MS || !_keyCache.has(kid))) {
    _lastFetchAt = now;
    try {
      const res = await fetchImpl(jwksUrl, { method: "GET" });
      if (res.ok) {
        const body = await res.json();
        for (const jwk of body?.keys || []) {
          const key = jwkToKey(jwk);
          if (key && typeof jwk.kid === "string") _keyCache.set(jwk.kid, { key, fetchedAt: now });
        }
      } else {
        warn?.(`[grant-verify] JWKS 取回 HTTP ${res.status}；沿用缓存（若有）`);
      }
    } catch (err) {
      warn?.(`[grant-verify] JWKS 取回失败：${err?.message || err}；沿用缓存（若有）`);
    }
  }
  const again = _keyCache.get(kid);
  return again ? again.key : null;
}

/**
 * 验签并返回 claims；任何一步不成立都返回 `null`（调用方据此**不注入**委托头）。
 *
 * 判据必须逐条过，缺一条就等于没验：
 *   - 三段式结构、`alg=EdDSA`（拒 `none` 与 HS256 降级攻击）
 *   - 签名用 JWKS 里该 `kid` 的公钥对 `header.payload` 原文验（不能重编码，
 *     重编码会因 JSON 键序/空白不同而验不过）
 *   - `exp` 未过期、`aud` 命中白名单
 */
export async function verifyGrant(token, { jwksUrl, fetchImpl, warn, audiences = [], now = Date.now } = {}) {
  // 兜底到全局 fetch：调用方漏传 fetchImpl 时，旧实现会在取 JWKS 处抛
  // "fetchImpl is not a function"，被 catch 吞成一条 warn，最终**返回 null**。
  // 那看起来和「这张票是伪造的」一模一样——2026-11-26 实测踩到：探针漏传该参数，
  // 于是一张真票被判无效，排查方向直接被带偏。兜底后漏传只会退化成「用默认 fetch」。
  fetchImpl = fetchImpl ?? globalThis.fetch;
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;

  let header;
  let claims;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
    claims = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "EdDSA" || typeof header?.kid !== "string") return null;

  const key = await publicKeyFor(header.kid, { jwksUrl, fetchImpl, warn });
  if (!key) return null;

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
  let ok = false;
  try {
    ok = cryptoVerify(null, signingInput, key, b64urlToBuf(parts[2]));
  } catch {
    return null;
  }
  if (!ok) return null;

  const expMs = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  if (expMs === null || expMs <= now()) return null;

  if (audiences.length) {
    const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    if (!aud.some((a) => audiences.includes(a))) return null;
  }
  return claims;
}

/** 从 Authorization: Bearer 里取 token 文本（没有则空串）。 */
export function bearerFrom(headerValue) {
  const v = String(headerValue || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(v);
  return m ? m[1].trim() : "";
}

/** 测试用：清空 JWKS 缓存。 */
export function _resetGrantKeyCache() {
  _keyCache.clear();
  _lastFetchAt = 0;
}
