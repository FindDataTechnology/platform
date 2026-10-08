// ── Mini-program identity path ────────────────────────────────────────────────
//
// WeChat mini-program clients cannot run the Logto browser redirect, so the
// platform offers a second identity path (openspec: miniprogram-auth) built
// on ACCOUNT BINDING via BIND CODES. Dual use (add-single-process-mp-auth):
// these modules are shared verbatim by the gateway (gateway/index.js) and the
// single-process server (server/routes/mp.js) — one login/bind implementation,
// two entrypoints.
//
//   First launch   → the user opens the WEB app in a browser (already signed
//                    in through Logto) and fetches a 6-digit bind code from
//                    GET /api/mp/bindcode (5-minute, single-use, bound to
//                    their account). They type that code ONCE on the
//                    mini-program login page; POST /api/mp/login-bindcode
//                    pairs the fresh wx.login code (which identifies the
//                    WeChat user) with the bind code (which proves account
//                    ownership). The server BINDS openid⇄account and issues
//                    a platform JWT carrying the ACCOUNT identity — the same
//                    email/groups as the web session, so the user lands on
//                    the same cell (gateway) or runtime (single-process) and
//                    shares data across both ends.
//
//   Every launch   → wx.login() code → POST /api/mp/login → the binding
//                    resolves the openid to the account → a fresh JWT.
//                    Completely silent: no UI, no interaction, because the
//                    openid itself reveals nothing personal.
//
//   Token expiry   → any request 401s → the client silently re-runs the code
//                    exchange and retries once.
//
//   Logout         → DELETE /api/mp/bind removes the binding; the next launch
//                    asks for a bind code again.
//
// Why bind codes and not a password grant: Logto deliberately does not
// implement the Resource Owner Password grant (deprecated in OAuth 2.1), and
// proxying its internal sign-in APIs would couple this flow to Logto's
// version internals. A bind code needs neither: no credentials ever reach
// the mini program, and the only dependency is this gateway's own web
// session. The JWT below is hand-rolled HS256 on node:crypto; MP_TOKEN_SECRET
// is deliberately separate from CELL_GATEWAY_SECRET so leaking one cannot
// forge the other.

import crypto from "node:crypto";

const B64 = "base64url";

// Demo identities (openspec: mp-demo-mode). `.invalid` is a reserved TLD, so
// a derived demo email can never collide with a real account email; the
// sha256 prefix keeps the raw openid out of emails and filesystem paths while
// staying deterministic — the same WeChat user resolves to the same demo
// dataset across launches. Exported for tests and for the client's
// "@demo.invalid means demo" convention.
export const DEMO_EMAIL_DOMAIN = "demo.invalid";

export function demoEmailFor(openid) {
  const hash = crypto.createHash("sha256").update(String(openid)).digest("hex").slice(0, 8);
  return `demo-${hash}@${DEMO_EMAIL_DOMAIN}`;
}

function hmacBuf(signingInput, secret) {
  return crypto.createHmac("sha256", secret).update(signingInput).digest();
}

export function signMpJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = Buffer.from(JSON.stringify(header)).toString(B64);
  const p = Buffer.from(JSON.stringify(payload)).toString(B64);
  return `${h}.${p}.${hmacBuf(`${h}.${p}`, secret).toString(B64)}`;
}

// Returns the payload for a valid, unexpired token; null for anything else
// (wrong shape, bad signature, expired). Signature comparison is
// constant-time on the decoded HMAC bytes.
export function verifyMpJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let expected;
  let got;
  try {
    expected = hmacBuf(`${h}.${p}`, secret);
    got = Buffer.from(s, B64);
  } catch {
    return null;
  }
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, B64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.email !== "string" || typeof payload.sub !== "string") return null;
  return payload;
}

export function createMpAuth(config) {
  const { appid, mpSecret, tokenSecret, ttlHours, codeUrl, bindings, demoMode = false } = config;
  const configured = Boolean(appid && mpSecret && tokenSecret);

  async function code2Session(code) {
    const url = `${codeUrl}?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(mpSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    let data;
    try {
      const res = await fetch(url);
      data = await res.json();
    } catch {
      return { ok: false, status: 502, error: "WeChat code2Session unreachable" };
    }
    if (data && typeof data.errcode === "number" && data.errcode !== 0) {
      return { ok: false, status: 401, error: `code2Session rejected: ${data.errcode} ${data.errmsg ?? ""}`.trim() };
    }
    if (!data || typeof data.openid !== "string" || !data.openid) {
      return { ok: false, status: 401, error: "code2Session returned no openid" };
    }
    return { ok: true, openid: data.openid };
  }

  function mintToken(openid, email, groups) {
    const now = Math.floor(Date.now() / 1000);
    return signMpJwt({ sub: openid, email, groups, iat: now, exp: now + ttlHours * 3600 }, tokenSecret);
  }

  // Silent login. Not-yet-bound openids: without demo mode NOT an error — the
  // client needs to be told to show the login page for a bind code. With demo
  // mode on (openspec: mp-demo-mode), an unbound openid instead gets a
  // demo-scoped token: a deterministic demo identity carrying the `demo`
  // group, so the gateway routes it to a bounded demo cell and the cell
  // applies demo limits. The reviewer path needs no bind code and no UI.
  async function login(code) {
    if (!configured) return { ok: false, status: 503, error: "Mini-program login is not configured" };
    if (typeof code !== "string" || !code.trim()) return { ok: false, status: 400, error: "Missing code" };
    const session = await code2Session(code);
    if (!session.ok) return session;
    const binding = bindings.get(session.openid);
    if (!binding) {
      if (!demoMode) return { ok: false, status: 404, error: "binding_required" };
      const email = demoEmailFor(session.openid);
      return { ok: true, token: mintToken(session.openid, email, ["demo"]), email };
    }
    return {
      ok: true,
      token: mintToken(session.openid, binding.email, binding.groups),
      email: binding.email,
    };
  }

  // First sign-in: a wx.login code (proves a genuine WeChat user) + a bind
  // code minted from the account's authenticated web session. Redeems the
  // bind code (single use), binds the openid, returns the platform token.
  async function loginWithBindCode(code, bindCode) {
    if (!configured) return { ok: false, status: 503, error: "Mini-program login is not configured" };
    if (typeof code !== "string" || !code.trim()) return { ok: false, status: 400, error: "Missing code" };
    const normalized = typeof bindCode === "string" ? bindCode.trim() : "";
    if (!/^\d{6}$/.test(normalized)) return { ok: false, status: 400, error: "请输入 6 位绑定码" };

    const session = await code2Session(code);
    if (!session.ok) return session;

    const entry = bindings.consumeBindCode(normalized);
    if (!entry) return { ok: false, status: 401, error: "绑定码无效或已过期" };

    await bindings.set(session.openid, { email: entry.email, groups: entry.groups });
    return {
      ok: true,
      token: mintToken(session.openid, entry.email, entry.groups),
      email: entry.email,
    };
  }

  // Logout: remove the binding behind a valid token.
  async function unbind(token) {
    const payload = verifyMpJwt(token, tokenSecret);
    if (!payload) return { ok: false, status: 401 };
    await bindings.remove(payload.sub);
    return { ok: true, email: payload.email };
  }

  function verifyToken(token) {
    if (!configured) return null;
    return verifyMpJwt(token, tokenSecret);
  }

  return { login, loginWithBindCode, unbind, verifyToken, configured };
}
