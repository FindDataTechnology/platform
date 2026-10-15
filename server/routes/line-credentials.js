// Per-line operation-MCP credential API (add-line-credential-refs, design D4).
//
// Family shape (connector/facet-market routes): token write-only, projections
// carry state only, identity-keyed, auth off = machine owner. Line-specific
// shape validation: wire-customer/lex accept a minted Logto ID token (3 JWT
// segments + parseable exp); wanxing-caller accepts a sub2api `sk-` paste.
// Unknown line → 404.
//
// The ID-token mint (wire-customer/lex) is a SERVER-DRIVEN authorization-code
// round trip. The first cut minted in the browser (popup + PKCE + poll the
// popup's location) and could not work in production: reading a cross-origin
// popup's location.href always throws SecurityError, and wire's auth/config
// endpoint carries no CORS headers. Both line clients now register the
// platform callback, so the flow is: browser navigates to `mint/start`
// (prompt=none — the shared Logto session makes it silent; one interactive
// consent ever), Logto redirects to `mint/callback` ON THIS ORIGIN, and the
// server exchanges the code for the ID token. No CORS anywhere, no token in
// browser JS, no client secret (PKCE only — the lines' clients are SPAs).

import { createHash, randomBytes } from "node:crypto";
import { clearCookie, parseCookies, sessionCookie, verifySignedCookie } from "../session.js";
import * as lineCredentials from "../../line-credentials.js";

const LINES = new Set(["wire-customer", "lex", "wanxing-caller"]);
const MINT_LINES = new Set(["wire-customer", "lex"]);
const MINT_COOKIE = "paas_line_mint";
const MINT_TTL_MS = 10 * 60 * 1000;
const CONFIG_TIMEOUT_MS = 8000;

// Per-line public auth-config endpoints (client_id/scopes/issuer — no
// secrets). Read at mint time so a line rotating its SPA client needs no
// platform redeploy; `ctx.lineMintTargets` overrides in tests.
const DEFAULT_MINT_TARGETS = {
  "wire-customer": { configUrl: "https://wire.finddatatech.cloud/api/console/auth/config" },
  lex: { configUrl: "https://lex.finddatatech.cloud/api/console/auth/config" },
};

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

function requestBase(req, configured) {
  if (configured) return String(configured).replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}

function secureRequest(req, ctx) {
  return requestBase(req, ctx.PAAS_BASE_URL).startsWith("https://") || req.secure;
}

function mintCallbackUri(req, ctx, line) {
  return `${requestBase(req, ctx.PAAS_BASE_URL)}/api/lines/${line}/mint/callback`;
}

// Every mint failure lands the user back on the settings surface with a
// reason marker the panel turns into "连接未完成——请重试". Never echoes
// upstream bodies (they can carry token material).
function mintFail(res, line, reason) {
  console.warn(`[line-credentials] mint ${line} failed: ${reason}`);
  res.redirect(`/settings/mcp?tab=market&lineError=${encodeURIComponent(line)}`);
}

function jwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtExpiry(token) {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

function connectionPayload(email, line) {
  return { line, ...lineCredentials.status(email, line) };
}

function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[line-credentials] profile update failed: ${e.message}`));
}

export function registerLineCredentialRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/lines/:line/connection", (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null, line));
  });

  // Mint leg 1: build the authorize URL and remember PKCE + state in a signed
  // cookie. prompt=none first; the callback retries once interactively when
  // Logto answers login_required/consent_required (first ever use per user).
  app.get("/api/lines/:line/mint/start", async (req, res) => {
    const line = req.params.line;
    const targets = ctx.lineMintTargets || DEFAULT_MINT_TARGETS;
    if (!MINT_LINES.has(line) || !targets[line]) {
      return res.status(404).json({ error: "Unknown line" });
    }
    if (!requireOwner(req, res, ctx)) return;
    if (typeof ctx.resolveSessionSecret !== "function") {
      return res.status(503).json({ error: "Mint is disabled (no session secret)" });
    }
    const fetchImpl = ctx.fetchImpl || fetch;
    let cfg;
    try {
      const r = await fetchImpl(targets[line].configUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cfg = await r.json();
    } catch (e) {
      return mintFail(res, line, `auth config unreadable: ${e?.message || e}`);
    }
    if (!cfg?.configured || !cfg?.client_id || !cfg?.issuer) {
      return mintFail(res, line, "line login is not configured");
    }

    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const interactive = req.query.interactive === "1";
    const secret = await ctx.resolveSessionSecret();
    res.append(
      "Set-Cookie",
      sessionCookie(
        MINT_COOKIE,
        {
          line,
          state,
          nonce,
          codeVerifier,
          issuer: String(cfg.issuer).replace(/\/+$/, ""),
          clientId: String(cfg.client_id),
          interactive,
          exp: Math.floor(Date.now() / 1000) + MINT_TTL_MS / 1000,
        },
        secret,
        MINT_TTL_MS,
        secureRequest(req, ctx),
      ),
    );

    const url = new URL(`${String(cfg.issuer).replace(/\/+$/, "")}/oidc/auth`);
    const scope = (Array.isArray(cfg.scopes) ? cfg.scopes : ["openid", "profile", "email"])
      .filter((s) => s !== "offline_access")
      .join(" ");
    for (const [key, value] of Object.entries({
      client_id: String(cfg.client_id),
      response_type: "code",
      scope,
      redirect_uri: mintCallbackUri(req, ctx, line),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      ...(interactive ? {} : { prompt: "none" }),
    })) {
      url.searchParams.set(key, value);
    }
    res.redirect(url.toString());
  });

  // Mint leg 2: Logto returns here (this origin — the callback is registered
  // on each line's SPA client). Verify state against the signed cookie,
  // exchange code→ID token server-side (PKCE, no secret), store, and land the
  // browser back on the settings surface.
  app.get("/api/lines/:line/mint/callback", async (req, res) => {
    const line = req.params.line;
    const targets = ctx.lineMintTargets || DEFAULT_MINT_TARGETS;
    if (!MINT_LINES.has(line) || !targets[line]) {
      return res.status(404).json({ error: "Unknown line" });
    }
    if (!requireOwner(req, res, ctx)) return;
    if (typeof ctx.resolveSessionSecret !== "function") {
      return res.status(503).json({ error: "Mint is disabled (no session secret)" });
    }
    const secret = await ctx.resolveSessionSecret();
    const cookie = parseCookies(req.headers.cookie)[MINT_COOKIE];
    const st = cookie ? verifySignedCookie(cookie, secret) : null;
    res.append("Set-Cookie", clearCookie(MINT_COOKIE, secureRequest(req, ctx)));
    if (!st || st.line !== line || st.state !== req.query.state) {
      return mintFail(res, line, "state mismatch");
    }

    const upstreamError = typeof req.query.error === "string" ? req.query.error : "";
    if (upstreamError) {
      // First ever use per user: Logto wants one interactive consent. Retry
      // exactly once without prompt=none; a second failure is final.
      if (!st.interactive && ["login_required", "consent_required", "interaction_required"].includes(upstreamError)) {
        return res.redirect(`/api/lines/${line}/mint/start?interactive=1`);
      }
      return mintFail(res, line, `authorization declined: ${upstreamError}`);
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return mintFail(res, line, "no authorization code");

    const fetchImpl = ctx.fetchImpl || fetch;
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: mintCallbackUri(req, ctx, line),
        client_id: st.clientId,
        code_verifier: st.codeVerifier,
      });
      const r = await fetchImpl(`${st.issuer}/oidc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
      const doc = await r.json().catch(() => ({}));
      const idToken = doc?.id_token;
      if (typeof idToken !== "string" || !idToken) throw new Error("token endpoint returned no id_token");
      // The nonce we requested must come back (OIDC: present whenever the
      // authorize request carried one). Signature/audience/org checks stay
      // upstream — the lines verify the token themselves.
      const claims = jwtPayload(idToken);
      if (!claims || claims.nonce !== st.nonce) throw new Error("nonce mismatch");
      const user = identity(req);
      if (!lineCredentials.store({ email: user?.email ?? null, line, token: idToken })) {
        throw new Error("store failed");
      }
      res.redirect("/settings/mcp?tab=market");
      reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
    } catch (e) {
      mintFail(res, line, `exchange failed: ${e?.message || e}`);
    }
  });

  app.post("/api/lines/:line/credential", async (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    const { token } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    const value = token.trim();
    if (value.length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    if (line === "wanxing-caller") {
      if (!value.startsWith("sk-")) {
        return res.status(400).json({
          error: "That is not a Wanxing caller key — caller keys start with sk_ (mint one at token.finddatatech.cloud)",
        });
      }
    } else {
      // wire-customer / lex: a minted Logto ID token (3 JWT segments + exp).
      const exp = jwtExpiry(value);
      if (exp === null) {
        return res.status(400).json({
          error: "That is not an ID token — connect via the line's silent mint (or paste a fresh ID token)",
        });
      }
      if (exp <= Date.now()) {
        return res.status(400).json({ error: "That ID token is already expired — mint a fresh one" });
      }
    }
    const user = identity(req);
    const status = lineCredentials.store({ email: user?.email ?? null, line, token: value });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    res.json(connectionPayload(user?.email ?? null, line));
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });

  app.delete("/api/lines/:line/connection", (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    lineCredentials.disconnect(user?.email ?? null, line);
    res.json({ ok: true, ...connectionPayload(user?.email ?? null, line) });
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });
}
