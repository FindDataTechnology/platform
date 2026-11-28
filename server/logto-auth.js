import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import {
  clearCookie,
  parseCookies,
  sessionCookie,
  verifySessionCookie,
  verifySignedCookie,
  STATE_TTL_MS,
} from "./session.js";
import { fetchWithTimeout, isRetryableFetchError, isRetryableHttpStatus } from "../lib/fetch-with-timeout.js";

const SESSION_COOKIE = "paas_session";
const STATE_COOKIE = "paas_oauth_state";
// Two independent Logto scopes: `organizations` yields the org IDs, while
// `organization_roles` yields "<org_id>:<role_name>" — the only place a role's
// NAME appears. Requesting just the first leaves mapGroups() with org IDs and
// no group names, so an ADMIN_GROUPS entry can never match.
const ORGANIZATION_SCOPE = "urn:logto:scope:organizations";
const ORGANIZATION_ROLES_SCOPE = "urn:logto:scope:organization_roles";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function requestBase(req, configured) {
  if (configured) return configured.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}

// Same-origin return path for the post-login redirect: relative, one leading
// "/", not "//" (protocol-relative = open redirect). An absolute URL counts
// only when its origin IS this deployment's — the web client passes
// window.location.href verbatim — and is reduced to its path. Anything else
// (other hosts, non-URLs) → "/".
function safeReturnPath(value, base) {
  if (typeof value !== "string" || value === "") return "/";
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    if (base && url.origin === new URL(base).origin) return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    /* not an absolute URL */
  }
  return "/";
}

// ui_locales passthrough: any ≤10-char [a-zA-Z-] value; Logto ignores unknowns.
function safeUiLocales(value) {
  if (typeof value !== "string" || !/^[a-zA-Z-]{1,10}$/.test(value)) return undefined;
  return value;
}

function isPublicClient(config) {
  return config.LOGTO_CLIENT_TYPE === "public";
}

function tokenError(res, kind = "token") {
  res.redirect(`/?auth_error=${kind}`);
}

function redirectUrl(discovery, params) {
  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

// Outbound call discipline: every Logto face (discovery, JWKS, token endpoint)
// rides the shared deadline wrapper (default env bound) — a stalled IdP fails
// the sign-in as a retryable failure instead of hanging the browser redirect;
// fetchImpl stays the test seam.
async function fetchJson(fetchImpl, url, options) {
  const response = await fetchWithTimeout(url, options, { fetchImpl });
  // LogtoRequestError (not a bare Error) so the boot retry below can tell a
  // transient 5xx/429 from a semantic 4xx. Message shape is unchanged.
  if (!response.ok) throw new LogtoRequestError(`Logto HTTP ${response.status}`, response.status);
  return response.json();
}

// Boot-time discovery is the one place where a SINGLE transient network blip is
// fatal: createLogtoAuth runs before the server listens, so one 10s timeout
// exits the process and kubelet restarts the whole platform — every cell with
// it (fd-prod 2026-11-08: three consecutive restarts on
// auth.finddatatech.cloud/oidc/.well-known/openid-configuration, which also
// takes the admin surface down while it retries). Retry the TRANSIENT classes
// (timeout, connect/DNS failure, 408/429/5xx) with bounded backoff; semantic
// failures (bad config, incomplete discovery, 4xx) still fail fast so a real
// misconfiguration stays loud instead of becoming a slow crash loop.
class LogtoRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LogtoRequestError";
    this.status = status;
  }
}

function retryable(err) {
  if (err instanceof LogtoRequestError) return isRetryableHttpStatus(err.status);
  return isRetryableFetchError(err);
}

async function fetchJsonWithRetry(fetchImpl, url, options, { attempts = 5, backoffMs = 1000, log = console } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await fetchJson(fetchImpl, url, options);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !retryable(err)) break;
      const delay = backoffMs * 2 ** (attempt - 1);
      log.warn(
        `[auth] ${url} failed (${err?.message || err}); retry ${attempt}/${attempts - 1} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function keyForHeader(header, jwks) {
  const key = jwks.keys?.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new Error("Logto JWKS key not found");
  return createPublicKey({ key, format: "jwk" });
}

// JWS alg -> the digest Node needs. ECDSA signatures are verified in JWS encoding
// (raw r||s, "ieee-p1363"), not DER; dsaEncoding is ignored for RSA, so RS256 rides
// the same call. Logto's stock tenant key signs ES384 — supporting only
// RS256/ES256 rejects every token it issues.
const ID_TOKEN_ALGS = { RS256: "sha256", ES256: "sha256", ES384: "sha384", ES512: "sha512" };

function verifyIdToken(token, discovery, clientId, nonce, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  const signature = Buffer.from(parts[2], "base64url");
  const hash = ID_TOKEN_ALGS[header.alg];
  if (!hash) throw new Error("Unsupported ID token algorithm");
  const discoveryKeys = discovery.jwks || {};
  const key = keyForHeader(header, discoveryKeys);
  if (!verify(hash, Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, signature)) {
    throw new Error("Invalid ID token signature");
  }
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
  if (payload.iss !== discovery.issuer || !audience.includes(clientId)) throw new Error("Invalid ID token claims");
  if (!Number.isFinite(payload.exp) || payload.exp <= now / 1000) throw new Error("Expired ID token");
  if (nonce && payload.nonce !== nonce) throw new Error("Invalid ID token nonce");
  return payload;
}

function mapGroups(claims) {
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
  const roles = Array.isArray(claims.organization_roles) ? claims.organization_roles : [];
  const roleNames = roles.map((role) => String(role).split(":").pop());
  return unique([...organizations.map(String), ...roleNames]);
}

export async function createLogtoAuth(config, { fetchImpl = fetch } = {}) {
  const mode = config.AUTH_MODE;
  if (mode !== "logto") return null;
  const endpoint = String(config.LOGTO_ENDPOINT || "").replace(/\/+$/, "");
  const clientId = String(config.LOGTO_APP_ID || "").trim();
  const clientSecret = String(config.LOGTO_APP_SECRET || "").trim();
  const publicClient = isPublicClient(config);
  if (!endpoint || !clientId || (publicClient ? false : !clientSecret)) {
    throw new Error("AUTH_MODE=logto requires LOGTO_ENDPOINT, LOGTO_APP_ID, and LOGTO_APP_SECRET for confidential clients");
  }

  const discoveryUrl = endpoint.endsWith("/oidc")
    ? `${endpoint}/.well-known/openid-configuration`
    : `${endpoint}/oidc/.well-known/openid-configuration`;
  const attempts = Number(config.LOGTO_DISCOVERY_ATTEMPTS || 5);
  const backoffMs = Number(config.LOGTO_DISCOVERY_BACKOFF_MS || 1000);
  const retryOpts = { attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 5, backoffMs: Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : 1000 };
  const discovery = await fetchJsonWithRetry(fetchImpl, discoveryUrl, undefined, retryOpts);
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) {
    throw new Error("Logto OIDC discovery response is incomplete");
  }
  const jwks = await fetchJsonWithRetry(fetchImpl, discovery.jwks_uri, undefined, retryOpts);
  const sessionSecret = await config.resolveSessionSecret();
  const ttlMs = Math.max(1, Number(config.SESSION_TTL_HRS || 24)) * 60 * 60 * 1000;
  const endSessionEnabled = config.LOGTO_END_SESSION === "true";

  function secureCookie(req) {
    return requestBase(req, config.PAAS_BASE_URL).startsWith("https://") || req.secure;
  }

  function sessionFromCookie(header) {
    const value = parseCookies(header)[SESSION_COOKIE];
    return value ? verifySessionCookie(value, sessionSecret) : null;
  }

  function slideCookie(req, res, payload) {
    if (!payload || payload.exp * 1000 > Date.now() + ttlMs / 2) return;
    const renewed = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlMs / 1000 };
    res.append("Set-Cookie", sessionCookie(SESSION_COOKIE, renewed, sessionSecret, ttlMs, secureCookie(req)));
  }

  async function login(req, res) {
    const state = base64url(randomBytes(24));
    const nonce = base64url(randomBytes(24));
    const codeVerifier = publicClient ? base64url(randomBytes(32)) : null;
    const codeChallenge = codeVerifier ? base64url(createHash("sha256").update(codeVerifier).digest()) : null;
    const redirectUri = `${requestBase(req, config.PAAS_BASE_URL)}/auth/callback`;
    const rd = safeReturnPath(req.query.rd, requestBase(req, config.PAAS_BASE_URL));
    const uiLocales = safeUiLocales(req.query.ui_locales);
    const statePayload = { state, nonce, codeVerifier, rd, exp: Math.floor(Date.now() / 1000) + STATE_TTL_MS / 1000 };
    res.append("Set-Cookie", sessionCookie(STATE_COOKIE, statePayload, sessionSecret, STATE_TTL_MS, secureCookie(req)));
    res.redirect(redirectUrl(discovery, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ["openid", "profile", "email", ORGANIZATION_SCOPE, ORGANIZATION_ROLES_SCOPE].join(" "),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallenge ? "S256" : undefined,
      ui_locales: uiLocales,
    }));
  }

  async function callback(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    const statePayload = cookies[STATE_COOKIE] ? verifySignedCookie(cookies[STATE_COOKIE], sessionSecret) : null;
    res.append("Set-Cookie", clearCookie(STATE_COOKIE, secureCookie(req)));
    if (!statePayload || statePayload.state !== req.query.state) return tokenError(res, "state");
    if (!req.query.code) return tokenError(res);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: `${requestBase(req, config.PAAS_BASE_URL)}/auth/callback`,
      client_id: clientId,
    });
    if (publicClient) {
      if (!statePayload.codeVerifier) return tokenError(res);
      body.set("code_verifier", statePayload.codeVerifier);
    } else {
      body.set("client_secret", clientSecret);
    }

    try {
      const tokens = await fetchJson(fetchImpl, discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const claims = verifyIdToken(tokens.id_token, { ...discovery, jwks }, clientId, statePayload.nonce);
      const email = claims.email;
      if (!email) throw new Error("ID token has no email");
      const payload = { email, groups: mapGroups(claims), exp: Math.floor(Date.now() / 1000) + ttlMs / 1000 };
      res.append("Set-Cookie", sessionCookie(SESSION_COOKIE, payload, sessionSecret, ttlMs, secureCookie(req)));
      res.redirect(safeReturnPath(statePayload.rd, requestBase(req, config.PAAS_BASE_URL)));
    } catch (error) {
      console.error("[logto] callback failed:", error.message);
      tokenError(res);
    }
  }

  async function logout(req, res) {
    res.append("Set-Cookie", clearCookie(SESSION_COOKIE, secureCookie(req)));
    if (!endSessionEnabled || !discovery.end_session_endpoint) return res.redirect("/");
    const url = new URL(discovery.end_session_endpoint);
    // Logto honors post_logout_redirect_uri only when the request names the
    // client: without client_id the flow dead-ends on its sign-out success
    // page instead of returning here (live-probed 2026-10-03).
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("post_logout_redirect_uri", `${requestBase(req, config.PAAS_BASE_URL)}/`);
    res.redirect(url.toString());
  }

  function register(app) {
    app.get("/auth/login", login);
    app.get("/auth/callback", callback);
    app.get("/api/auth/logout", logout);
    app.post("/api/auth/logout", logout);
  }

  return {
    register,
    userFromCookie: sessionFromCookie,
    authenticate(req, res) {
      const user = sessionFromCookie(req.headers.cookie);
      slideCookie(req, res, user);
      return user;
    },
    discovery,
  };
}

export { mapGroups, verifyIdToken };
