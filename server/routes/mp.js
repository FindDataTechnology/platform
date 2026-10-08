// Mini-program identity endpoints (openspec: miniprogram-auth) — the same
// four routes the gateway serves, backed by the SAME shared modules
// (gateway/mp-auth.js + gateway/mp-bindings.js) so both entrypoints keep one
// login/bind implementation.
//
// Auth shape here differs from the gateway only in who rejects
// unauthenticated traffic: registerAuth's logto gate runs BEFORE these
// routes, so /api/mp/bindcode and DELETE /api/mp/bind never see an
// unauthenticated caller (browsers are redirected to login, programmatic
// callers get 401 — same contract the gateway's rejectUnauthenticated
// provides). The two login endpoints are exempt from the session requirement
// (server/auth.js MP prefix list): a mini program has no browser session;
// each call authenticates through its own wx.login exchange / bind code.
//
// JSON bodies arrive pre-parsed by server.js's global express.json().

export function registerMpRoutes(ctx) {
  const { app, mpAuth } = ctx;

  // Bind-code minting for the web side: an authenticated session (Logto
  // cookie, MP Bearer token, or forward-auth identity) gets a 6-digit,
  // single-use, 5-minute code to type into the mini program once. Browsers
  // get a small human-readable page; programmatic clients get JSON.
  app.get("/api/mp/bindcode", (req, res) => {
    const user = req.user;
    if (!user?.email) return res.status(401).json({ error: "Authentication required" });
    const { code, ttlMs } = ctx.mpBindings.issueBindCode(user.email, user.groups ?? []);
    if (req.accepts("json") && !req.accepts("html")) {
      return res.json({ code, ttlMs });
    }
    res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>绑定小程序</title>
<body style="font-family:system-ui;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f3f4f6">
  <div style="text-align:center;background:#fff;padding:48px 64px;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <div style="color:#6b7280;font-size:14px">微信小程序 · 登录绑定码（${user.email}）</div>
    <div style="font-size:56px;letter-spacing:12px;font-weight:700;color:#111827;margin:24px 0">${code}</div>
    <div style="color:#9ca3af;font-size:13px">5 分钟内有效，一次性使用。在小程序登录页输入此码完成绑定。</div>
    <div style="margin-top:20px"><a href="/api/mp/bindcode" style="color:#2563eb;font-size:14px">刷新新码</a></div>
  </div>
</body>`);
  });

  // Silent login: wx.login code in, platform token out. A 404 with
  // `binding_required` tells the client this openid has no bound account yet
  // and it should show the login page. Not-configured deployments answer
  // 503 (mpAuth's inertness contract).
  app.post("/api/mp/login", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const r = await mpAuth.login(code);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  // First sign-in: a fresh wx.login code + a bind code minted from the
  // account's web session. Redeems the code, binds the openid to the
  // account, returns the same platform token the silent path issues.
  app.post("/api/mp/login-bindcode", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const bindCode = typeof req.body?.bindCode === "string" ? req.body.bindCode : "";
    const r = await mpAuth.loginWithBindCode(code, bindCode);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  // Logout: removes the openid⇄account binding behind the presented token.
  // The next launch asks for credentials again.
  app.delete("/api/mp/bind", async (req, res) => {
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const r = await mpAuth.unbind(token);
    if (!r.ok) return res.status(r.status).json({ error: "Invalid token" });
    res.json({ ok: true });
  });
}
