// Per-user 柏讯模拟交易 `fdt_` token API (add-paper-trading-credentials,
// design D5).
//
// Mirrors the connector credential routes' shape and rules: token write-only
// from the browser (projections carry state, never the token), reads/writes
// keyed to the requesting identity, auth off = the machine owner. The paste
// endpoint adds the double validation: an `fdt_` shape check plus a one-shot
// liveness probe against the service's own REST — a 401 means the token is
// dead or wrong and is rejected outright; a network failure stores anyway (a
// service outage must not block saving a credential).
//
// The probe target / card hint comes from the origin chain (fix-trading-pack-
// composition 3.3): the market entry's consumption endpoint (the same address
// a connection composes — the duplicate baseline row is gone) →
// PAPER_TRADING_SERVICE_ORIGIN → none. Without an origin, pasting still works
// (shape check only) and the card carries no service URL.

import * as paperTradingCredentials from "../../paper-trading-credentials.js";
import { findMarketMcpEntry } from "../../extension-store.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

// Anonymous writes are rejected in hosted mode, exactly like the registry/
// connector credential routes: the row decides which token the runtime injects
// into the paper-trading MCP connection, so it must belong to an authenticated
// user.
function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

// The origin chain: the market entry's consumption endpoint first (it is what
// a connection composes — one address, never two), then the operator env
// override, then none. null = the probe is skipped and the card has no hint;
// that is the same advisory-probe degradation as before, not an error.
// `findEntry` is the test seam for the three forms (entry / env / neither).
export async function paperTradingOrigin({ findEntry = findMarketMcpEntry } = {}) {
  try {
    const entry = await findEntry("fd-paper-trading");
    const url = entry?.configTemplate?.url;
    if (typeof url === "string" && url.trim()) return new URL(url.trim()).origin;
  } catch {
    // market source unavailable or a malformed entry URL → env fallback
  }
  const envOrigin = String(process.env.PAPER_TRADING_SERVICE_ORIGIN || "").trim().replace(/\/+$/, "");
  return envOrigin || null;
}

async function connectionPayload(email) {
  const origin = await paperTradingOrigin();
  return {
    ...paperTradingCredentials.status(email),
    // Deployment config, not a secret — where the card's "get a token" hint
    // sends the user (the service's own web UI).
    serviceUrl: origin,
  };
}

// One liveness probe with the candidate token: GET the service REST that the
// MCP transport authenticates per request. 401 = definitively not accepted;
// anything else (200, 4xx other than 401, network error) leaves the decision
// to the store — the probe is advisory, the only hard verdict is a 401.
async function probeRejected(origin, token) {
  try {
    const res = await fetch(`${origin}/api/v1/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

// A credential change IS an effective-profile change — same fire-and-forget
// reapply as the connector/facet-market routes.
function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[paper-trading] profile update failed: ${e.message}`));
}

export function registerPaperTradingRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/paper-trading/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Paper-trading credentials are disabled (database unavailable)" });
    }
    connectionPayload(identity(req)?.email ?? null).then(
      (payload) => res.json(payload),
      (e) => res.status(500).json({ error: e?.message || "failed to resolve the service origin" }),
    );
  });

  // Paste an `fdt_` token minted on the service web. Shape first (the fdt_
  // prefix — the service's token kind), then the advisory liveness probe.
  app.post("/api/paper-trading/connection", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Paper-trading credentials are disabled (database unavailable)" });
    }
    const { token } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    const value = token.trim();
    if (value.length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    if (!value.startsWith("fdt_")) {
      return res.status(400).json({ error: "That is not a paper-trading token — service tokens start with fdt_" });
    }
    const origin = await paperTradingOrigin();
    if (origin && (await probeRejected(origin, value))) {
      // The token itself answered 401: revoked or never valid. Never echoed back.
      return res.status(400).json({ error: "The paper-trading service rejected this token (revoked or invalid). Mint a fresh one on the service web." });
    }
    const user = identity(req);
    const email = user?.email ?? null;
    const status = paperTradingCredentials.store({ email, token: value });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    res.json(status);
    reapplyProfile(ctx, email, user?.groups ?? null);
  });

  // Disconnect: the credential goes away, so the next profile write omits the
  // paper-trading server. Revocation is the user's own move on the service web
  // (a paste carries no server-side revocation handle) — never blocked here.
  app.delete("/api/paper-trading/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Paper-trading credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    const email = user?.email ?? null;
    paperTradingCredentials.disconnect(email);
    connectionPayload(email).then(
      (payload) => res.json({ ok: true, ...payload }),
      (e) => res.status(500).json({ error: e?.message || "failed to resolve the service origin" }),
    );
    reapplyProfile(ctx, email, user?.groups ?? null);
  });
}
