// Per-user Chatwoot credential API (add-crm-desk-pack-embed task 2.1).
//
// Family shape (line-credentials paste family): token write-only, projections
// carry state only, identity-keyed, auth off = machine owner. Chatwoot is a
// pure paste line — no mint flow. The optional login email/password ride the
// same save and serve only the embed's server-side sign-in; projections never
// echo them back.

import * as chatwootCredentials from "../../chatwoot-credentials.js";

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

function connectionPayload(email) {
  const s = chatwootCredentials.status(email);
  return {
    ref: chatwootCredentials.CHATWOOT_CREDENTIAL_REF,
    connected: s.connected,
    stale: s.stale,
    hasLoginCredentials: s.hasLoginCredentials,
  };
}

function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[chatwoot-credentials] profile update failed: ${e.message}`));
}

export function registerChatwootCredentialRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/chatwoot/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Chatwoot credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null));
  });

  app.post("/api/chatwoot/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Chatwoot credentials are disabled (database unavailable)" });
    }
    const { token, loginEmail, loginPassword } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    if (token.trim().length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    if (loginPassword && !loginEmail?.trim()) {
      return res.status(400).json({ error: "Login password requires the login email" });
    }
    for (const [name, value] of [["loginEmail", loginEmail], ["loginPassword", loginPassword]]) {
      if (value != null && String(value).length > 1024) {
        return res.status(400).json({ error: `${name} is too long` });
      }
    }
    const user = identity(req);
    chatwootCredentials.store({
      email: user?.email ?? null,
      token,
      loginEmail: loginEmail ?? null,
      loginPassword: loginPassword ?? null,
    });
    res.json(connectionPayload(user?.email ?? null));
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });

  app.delete("/api/chatwoot/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Chatwoot credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    chatwootCredentials.disconnect(user?.email ?? null);
    res.json(connectionPayload(user?.email ?? null));
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });
}
