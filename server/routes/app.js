// App device-pairing endpoints (openspec: add-device-pairing-auth) — the
// same five routes the gateway serves, backed by the SAME shared module
// (gateway/app-auth.js) so both entrypoints keep one pairing implementation.
//
// Auth shape mirrors server/routes/mp.js: registerAuth's gate runs before
// these routes, and the three pairing routes are exempt from the session
// requirement (server/auth.js prefix list) — a native app has no browser
// session; each call authenticates through the bind code / device key. The
// management routes take req.user (cookie / forward-auth identity) OR a valid
// app Bearer token — the gateway's resolveUser accepts the same token, and
// parity here is what lets the app list and unbind its own device without a
// browser nearby.
//
// JSON bodies arrive pre-parsed by server.js's global express.json().

export function registerAppRoutes(ctx) {
  const { app, appAuth } = ctx;

  // The caller's account email: the session identity, or the account behind
  // a kind=app Bearer token (which carries it).
  function callerEmail(req) {
    if (req.user?.email) return req.user.email;
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return appAuth.accountFromToken(token)?.email ?? null;
  }

  app.post("/api/app/pair", async (req, res) => {
    const r = await appAuth.pair(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.post("/api/app/challenge", (req, res) => {
    const r = appAuth.challenge(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ nonce: r.nonce, ttlMs: r.ttlMs });
  });

  app.post("/api/app/login", (req, res) => {
    const r = appAuth.login(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.get("/api/app/devices", (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    res.json(appAuth.devicesFor(email));
  });

  app.delete("/api/app/bind/:deviceId", async (req, res) => {
    const email = callerEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    const r = await appAuth.revoke(email, String(req.params?.deviceId ?? ""));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  });
}
