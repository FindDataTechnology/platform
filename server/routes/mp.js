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

import * as cron from "../../cron.js";

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

  // ── Command summary (openspec: add-mp-command-center) ────────────────────
  // One request for the mini program's command surface: what is waiting for
  // the user (pending agent questions, runtime snapshot) and how the
  // scheduled fleet is doing. Store-local by design (the M4④ summary
  // precedent — no cross-line joins here). Pending questions live in memory
  // BY SEMANTICS (a dead turn's ask is moot), so an empty state after a
  // restart is the honest truth, not a bug. The session-title join is
  // best-effort: a chat-history failure degrades titles to null, it never
  // fails the summary.
  app.get("/api/mp/command-summary", async (_req, res) => {
    try {
      const pending = [];
      for (const [sessionId, p] of ctx.pendingQuestionBySession ?? new Map()) {
        pending.push({ sessionId, askId: p.askId, toolCallId: p.toolCallId, questions: p.questions ?? [] });
      }
      let sessions = [];
      try {
        sessions = await ctx.chatHistory.listSessions();
      } catch { /* degraded join, not a failed summary */ }
      const titles = new Map(sessions.map((s) => [s.id, s.title ?? null]));
      for (const p of pending) p.sessionTitle = titles.get(p.sessionId) ?? null;

      const jobs = (ctx.cronList ?? cron.listJobs)();
      const attention = [];
      const counts = { total: jobs.length, active: 0, paused: 0, failed: 0, interrupted: 0, other: 0 };
      for (const job of jobs) {
        const last = job.history?.[job.history.length - 1];
        // Same bucket logic the MP cron page chips use, so the two surfaces
        // can never disagree about a job's state.
        let bucket;
        if (job.paused) bucket = "paused";
        else if (job.state === "queued" || job.state === "running") bucket = "active";
        else if (job.state === "failed") bucket = "failed";
        else if (job.state === "interrupted") bucket = "interrupted";
        else if (job.state === "error" || last?.success === false) bucket = "failed";
        else bucket = "active";
        counts[bucket === "paused" || bucket === "active" || bucket === "failed" || bucket === "interrupted" ? bucket : "other"]++;
        if (bucket === "failed" || bucket === "interrupted") {
          attention.push({
            id: job.id,
            title: job.sessionTitle ?? job.prompt?.slice(0, 60) ?? job.id,
            state: bucket,
            lastRun: job.lastRun ?? last?.time ?? null,
            error: last?.error ?? null,
          });
        }
      }
      const recentDone = jobs
        .flatMap((job) => (job.history ?? []).filter((h) => h.success).map((h) => ({ jobId: job.id, title: job.sessionTitle ?? job.prompt?.slice(0, 60) ?? job.id, time: h.time, duration: h.duration })))
        .sort((a, b) => String(b.time).localeCompare(String(a.time)))
        .slice(0, 5);

      res.json({ pendingQuestions: pending, jobs: { counts, attention, recentDone } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
