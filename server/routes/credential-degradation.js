// Credential degradation read face (change converge-line-identity-and-keys 4.2).
//
// Why this route exists: when the platform's channel to a line is unusable but
// the line's own credential is still in place, the profile writer keeps the
// server and records a degradation (credential-refs D5). Without a read face
// the user sees a working line and no explanation — and the operator-facing
// counter stays invisible. This route is the data source for the settings
// notice; it is deliberately read-only and owner-scoped.
//
// Family shape (line-credentials / facet-market / chatwoot routes): identity
// from the session, token-free projections only, DB unavailable = 503 rather
// than an empty list (empty would claim "nothing degraded", which we cannot
// know).

import * as federatedRef from "../../federated-ref.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

export function registerCredentialDegradationRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/credentials/degraded", (req, res) => {
    const email = identity(req)?.email ?? null;
    if (ctx.authEnabled && !email) {
      return res.status(401).json({ error: "Authentication is required" });
    }
    if (!db.isDbReady()) {
      // 不是"没有降级"，是"读不到"——两者不能同形（见 unknown-is-not-empty）。
      return res.status(503).json({ error: "Credential state is disabled (database unavailable)" });
    }
    res.json({
      degraded: federatedRef.federatedDegradedStats({ email }),
      asOf: new Date().toISOString(),
    });
  });
}
