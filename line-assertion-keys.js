// line-assertion-keys.js — 每线一把签名密钥 + JWKS（converge-line-identity-and-keys 2.3）
//
// 门 A 的平台侧：平台以「用户本人」的名义在某条线上做事，靠的是一份该线
// 专属密钥签出的断言。三条硬约束：
//
//   1. **每线一把**，不是一把通用钥匙——任一密钥泄漏的影响面被限制在该条线
//      （design D3）。跨线提交必须失败，且失败原因是「audience 不匹配」而不是
//      「签名不认」。
//   2. **私钥永不外传**：对外只出 JWKS（公钥 + kid + alg），列表接口连私钥的
//      影子都不带。
//   3. **轮换留一个 TTL 的宽限**：换新 kid 后旧 kid 仍可验，否则滚动瞬间
//      在飞的断言全炸。宽限窗口按 spec 取 5 分钟量级。
//
// 算法固定 ES384（断言体积小、验签快、node:crypto 原生）；JWT 手工拼，
// 不引新依赖——这个文件必须能在没有第三方库的环境里跑。

import crypto from "node:crypto";

import * as db from "./db.js";

export const ASSERTION_ALG = "ES384";
const CURVE = "P-384";
//: 轮换后旧 kid 的宽限（秒）。spec 的断言 TTL 上限是 300s，宽限与之同量级即可。
export const KEY_GRACE_SECONDS = 600;

const KEY_PREFIX = "federated.assertion.key.";

function keyName(line) {
  return `${KEY_PREFIX}${line}`;
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf.toString("base64url");
}

function load(line) {
  try {
    const raw = db.getPreference(keyName(line));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec.kid === "string" && rec.privatePem ? rec : null;
  } catch {
    return null;
  }
}

function store(line, rec) {
  db.setPreference(keyName(line), JSON.stringify(rec));
  return rec;
}

function newRecord(line) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: CURVE });
  const publicJwk = publicKey.export({ format: "jwk" });
  const kid = crypto.createHash("sha256").update(publicJwk.x + publicJwk.y).digest("base64url").slice(0, 16);
  return {
    line,
    kid,
    alg: ASSERTION_ALG,
    publicJwk: { ...publicJwk, kid, alg: ASSERTION_ALG, use: "sig" },
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    createdAt: new Date().toISOString(),
    retiredAt: null,
  };
}

// 取该线的当前密钥；不存在则生成（首次使用即铸，不需要单独的初始化步骤）。
export function ensureKey(line) {
  if (!line) throw new Error("line is required");
  const existing = load(line);
  if (existing) return existing;
  return store(line, newRecord(line));
}

// 轮换：铸新 kid，旧 kid 记 retiredAt 留在 JWKS 里直到宽限过。
export function rotateKey(line, now = new Date()) {
  const prev = load(line);
  const fresh = newRecord(line);
  const prevKeys = Array.isArray(prev?.previous) ? prev.previous : [];
  if (prev) {
    prevKeys.push({
      kid: prev.kid,
      alg: prev.alg,
      publicJwk: prev.publicJwk,
      retiredAt: now.toISOString(),
    });
  }
  // 只留仍在宽限内的旧钥（用 createdAt 无关，用 retiredAt 算）
  const cutoff = now.getTime() - KEY_GRACE_SECONDS * 1000;
  const kept = prevKeys.filter((k) => new Date(k.retiredAt).getTime() >= cutoff);
  return store(line, { ...fresh, previous: kept });
}

// 对外 JWKS：当前钥 + 宽限内的旧钥。**只有公钥**。
export function jwks(line, now = new Date()) {
  const rec = load(line);
  if (!rec) return { keys: [] };
  const cutoff = now.getTime() - KEY_GRACE_SECONDS * 1000;
  const prev = (rec.previous || []).filter((k) => new Date(k.retiredAt).getTime() >= cutoff);
  return { keys: [rec.publicJwk, ...prev.map((k) => k.publicJwk)] };
}

// 不含私钥的清单（运维核对「每条线一把、kid 唯一」用）。
export function listKeys(lines = []) {
  return lines
    .map((line) => load(line))
    .filter(Boolean)
    .map((rec) => ({
      line: rec.line,
      kid: rec.kid,
      alg: rec.alg,
      createdAt: rec.createdAt,
      retiredKids: (rec.previous || []).map((k) => k.kid),
    }));
}

// 签一份成员级断言。aud 就是这条线的公开基址（线侧用它判 audience）。
export function signAssertion({
  line,
  audience,
  sub,
  scope = [],
  ttlSeconds = 120,
  now = new Date(),
  extraClaims = {},
} = {}) {
  if (!line || !audience || !sub) throw new Error("line, audience and sub are required");
  if (ttlSeconds <= 0 || ttlSeconds > 300) {
    // spec: exp-iat 不得超过 5 分钟。在这里挡住，别让线侧当唯一闸门。
    throw new Error(`ttlSeconds must be within (0, 300], got ${ttlSeconds}`);
  }
  const rec = ensureKey(line);
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: ASSERTION_ALG, typ: "JWT", kid: rec.kid };
  const payload = {
    iss: "https://platform.finddatatech.cloud",
    sub,
    aud: audience,
    scope: Array.isArray(scope) ? scope.join(" ") : String(scope || ""),
    iat,
    exp: iat + ttlSeconds,
    jti: crypto.randomUUID(),
    ...extraClaims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha384", Buffer.from(signingInput), {
    key: crypto.createPrivateKey(rec.privatePem),
    dsaEncoding: "ieee-p1363",
  });
  return { token: `${signingInput}.${b64url(signature)}`, kid: rec.kid, payload };
}

// 本地验签（测试与自检用；线侧有自己的实现，这里只证明"发布出去的 JWKS 能用"）。
export function verifyWithJwks(token, jwksDoc) {
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) return { ok: false, reason: "malformed" };
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const jwk = (jwksDoc?.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown_kid" };
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify(
    "sha384",
    Buffer.from(`${h}.${p}`),
    { key: pub, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  );
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true, payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
}
