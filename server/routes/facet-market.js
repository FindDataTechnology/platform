// Per-user 谦面市场设备凭据 API (add-facet-market-credentials, design D5).
//
// Mirrors the connector credential routes' shape and rules: secret write-only
// (projections carry state — here not even a token exists to leak; the
// terminal token is minted server-side from the device key), reads/writes
// keyed to the requesting identity, auth off = the machine owner.
//
// Pairing takes a 6-digit bind code minted on the facet market's settings
// page (the same code the CLI publish bridge consumes); the server owns the
// Ed25519 keypair, so the browser never touches key material.

import * as facetMarketCredentials from "../../facet-market-credentials.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

// Same hosted-mode rule as the registry/connector credential routes.
function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

function connectionPayload(email) {
  return {
    ...facetMarketCredentials.status(email),
    facetUrl: facetMarketCredentials.facetMarketUrl(),
    bindPath: "/settings/devices",
  };
}

// A credential change IS an effective-profile change — same fire-and-forget
// reapply as the connector routes.
function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[facet-market] profile update failed: ${e.message}`));
}

export function registerFacetMarketRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/facet-market/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Facet market credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null));
  });

  app.post("/api/facet-market/pair", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Facet market credentials are disabled (database unavailable)" });
    }
    const { code } = req.body || {};
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      return res.status(400).json({ error: "请输入 6 位绑定码（在谦面市场设置页生成）" });
    }
    const user = identity(req);
    try {
      const status = await facetMarketCredentials.pair(user?.email ?? null, code.trim());
      res.json(status);
    } catch (e) {
      // Facet's own 400 (malformed — shouldn't happen) / 401 (bad/expired/
      // reused code) verdicts pass through verbatim; anything else is ours.
      if (e?.status === 401 || e?.status === 400) {
        return res.status(e.status).json({ error: e.message });
      }
      console.warn(`[facet-market] pair failed: ${e?.message || e}`);
      return res.status(502).json({ error: "谦面市场不可达，请稍后重试" });
    }
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });

  app.delete("/api/facet-market/connection", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Facet market credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    await facetMarketCredentials.disconnect(user?.email ?? null);
    res.json({ ok: true, ...connectionPayload(user?.email ?? null) });
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });
}
