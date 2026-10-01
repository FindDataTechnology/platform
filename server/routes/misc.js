// Misc routes: identity introspection, agent/app catalog, Nango connect
// broker, server config, supervisor status, preferences — plus the static SPA
// serving, registered separately (registerStaticAndFallback) so the
// composition root can place it after the app's /api routes.

import path from "node:path";
import express from "express";
import { WEB_DIST } from "../context.js";

export function registerMiscRoutes(ctx) {
  const { app, catalog, db, cron } = ctx;

  // Identity introspection: lets the frontend render login state without
  // inspecting headers. email/groups are null when auth is off. adminGroups
  // tells the web which group names gate admin surfaces (ADMIN_GROUPS).
  app.get("/api/auth/me", (req, res) => {
    const ssoUser = req.ssoUser || null;
    const mode = ctx.authMode || "none";
    const authenticated = ctx.authEnabled && Boolean(req.user?.email);
    res.json({
      mode,
      email: req.user?.email ?? null,
      groups: req.user?.groups ?? null,
      authenticated,
      adminGroups: ctx.adminGroups ?? ["admin"],
      loginUrl: mode === "logto" ? "/auth/login" : ctx.AUTH_LOGIN_PATH,
      logoutUrl: mode === "logto" ? "/api/auth/logout" : ctx.AUTH_LOGOUT_PATH,
      ssoConfigured: ctx.ssoEnabled,
      ssoAuthenticated: Boolean(ssoUser?.email),
      ssoEmail: ssoUser?.email ?? null,
      ssoGroups: ssoUser?.groups ?? null,
    });
  });

  // ── Agent & app catalog (agents.json + AGENTS_CONFIG_URL, see catalog.js) ──
  // GET is role-filtered + redacted per requesting user; POST refresh is
  // admin-gated when auth is on, open to any client when auth is off.
  app.get("/api/catalog", (req, res) => {
    res.json(catalog.getCatalogFor(req.user ?? null));
  });

  app.post("/api/catalog/refresh", async (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser?.(req.user)) {
      return res.status(403).json({ error: "Admin group required" });
    }
    try {
      res.json(await catalog.refresh(req.user ?? null));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Nango connect broker (nango-connect app entries) ─────────────────────
  // Mirrors connect-app/server.mjs: mint a connect session tagged to the
  // requesting user (org = email domain) so Nango isolates their connections,
  // and hand back the Connect UI URL. Requires forward-auth — there is no
  // identity to tag otherwise. The Nango secret stays server-side.
  app.post("/api/apps/:id/connect", async (req, res) => {
    if (!ctx.authEnabled || !req.user?.email) {
      return res.status(400).json({ error: "Connect requires AUTH_MODE=forward_auth" });
    }
    const entry = catalog.getAppEntry(req.params.id);
    if (!entry || entry.kind !== "nango-connect") {
      return res.status(404).json({ error: `Unknown nango-connect app: ${req.params.id}` });
    }
    const secret = process.env.NANGO_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: "NANGO_SECRET_KEY not set" });
    const email = req.user.email;
    try {
      const r = await fetch(`${entry.nangoUrl.replace(/\/+$/, "")}/connect/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          tags: { end_user_id: email, end_user_email: email, organization_id: email.split("@")[1] },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`Nango HTTP ${r.status}`);
      const data = await r.json();
      const ui = (entry.connectUiUrl || entry.nangoUrl).replace(/\/+$/, "");
      const api = encodeURIComponent((entry.apiUrl || entry.nangoUrl).replace(/\/+$/, ""));
      res.json({ url: `${ui}/?session_token=${data.token}&apiURL=${api}` });
    } catch (err) {
      console.error(`[apps] connect session for '${req.params.id}' failed:`, err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Readiness probe: 200 once the dsh agent finished initializing, 503 while
  // the (listen-first) server is still booting background services. Deeper
  // than a TCP check — used by the e2e webServer and suitable for deploy
  // probes that must not route traffic to a half-booted instance.
  app.get("/api/ready", (_req, res) => {
    res.status(ctx.ready.dsh ? 200 : 503).json({ ready: ctx.ready.dsh });
  });

  // ── Server config (documents state, deployment branding) ──────────────────
  // Branding resolution: stored (SQLite) → env → null. The web falls back to
  // localized defaults for each null field.
  const brandingField = (key, envName) => {
    const stored = db.isDbReady() ? db.getDeploymentConfig(key) : null;
    if (stored !== null && stored !== undefined) return stored;
    return (process.env[envName] || "").trim() || null;
  };

  app.get("/api/config", (_req, res) => {
    res.json({
      documentsEnabled: db.isDbReady(),
      // Pack marketplace surfaces (add-pack-marketplace): shown only on
      // gateway-fronted deployments — the market/publish APIs live on the
      // gateway, which a local single-process deployment does not have.
      packMarketplace: process.env.PACK_MARKETPLACE === "1",
      // The deployment's name for the assistant, shown in the sidebar, the turn
      // header and the composer placeholder. Unset (or blank) ⇒ null, and the
      // web keeps its own defaults.
      assistantName: brandingField("assistantName", "ASSISTANT_NAME"),
      companyName: brandingField("companyName", "COMPANY_NAME"),
      brandIconUrl: brandingField("brandIconUrl", "BRAND_ICON_URL"),
      loginFooterText: brandingField("loginFooterText", "LOGIN_FOOTER_TEXT"),
    });
  });

  // ── Branding write (admin-gated; open when auth off) ──────────────────────
  // Full-replace of provided fields: omitted = unchanged, empty string = clear
  // back to the env fallback. All strings capped at 200 chars; brandIconUrl
  // must be http(s):// when non-empty.
  const BRANDING_KEYS = ["companyName", "assistantName", "brandIconUrl", "loginFooterText"];

  app.put("/api/config/branding", (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser?.(req.user)) {
      return res.status(403).json({ error: "Admin group required" });
    }
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Branding is disabled (database unavailable)" });
    }
    const body = req.body || {};
    const updates = {};
    for (const key of BRANDING_KEYS) {
      if (!Object.hasOwn(body, key)) continue;
      const value = body[key];
      if (typeof value !== "string") {
        return res.status(400).json({ error: `Field '${key}' must be a string` });
      }
      if (value.length > 200) {
        return res.status(400).json({ error: `Field '${key}' exceeds 200 characters` });
      }
      if (key === "brandIconUrl" && value && !/^https?:\/\//.test(value)) {
        return res.status(400).json({ error: "brandIconUrl must be an http(s):// URL" });
      }
      updates[key] = value;
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === "") db.clearDeploymentConfig(key);
      else db.setDeploymentConfig(key, value);
    }
    res.json({ ok: true });
  });

  // ── Supervisor / system status (for the Dashboard view) ──────────────────
  // Returns NON-SECRET system status only. Never includes API keys or tokens.
  // In dev (node server.js) returns this server's own self-status. In the packaged
  // Electron app the Electron main process can override this via IPC (future); for
  // now it returns the same self-status which is sufficient for the dashboard.
  app.get("/api/supervisor/status", (_req, res) => {
    res.json({
      servers: [
        {
          id: "server-js",
          name: "Platform backend",
          kind: "node",
          state: "healthy",
          pid: process.pid,
          port: ctx.PORT,
          url: `http://localhost:${ctx.PORT}`,
        },
      ],
      provider: ctx.defaultModel ? ctx.defaultModel.provider : null,
      currentModel: ctx.defaultModel ? ctx.defaultModel.id : null,
      uptimeMs: process.uptime() * 1000,
    });
  });

  // ── Gateway-internal: enabled scheduled work ──────────────────────────────
  // The hosted gateway's idle reaper asks this before stopping a cell: a cell
  // holding an enabled cron job or bot is never reaped, because reaping means
  // that user's scheduled work silently stops firing. Only counts leave here.
  app.get("/api/gateway/jobs", (_req, res) => {
    if (!db.isDbReady()) return res.json({ enabledCron: 0, enabledBots: 0 });
    const enabledCron = cron.listJobs().filter((j) => !j.paused && j.status !== "expired" && j.status !== "completed").length;
    const enabledBots = db.listBots().filter((b) => b.enabled).length;
    res.json({ enabledCron, enabledBots });
  });

  // ── User preferences endpoints (single-user, key/value) ──────────────────
  // Stored in the SQLite project database. No authentication; no multi-tenancy.

  app.get("/api/preferences", (_req, res) => {
    res.json({ preferences: db.isDbReady() ? db.getAllPreferences() : {} });
  });

  // Upsert one preference: { key, value }. Idempotent on key.
  app.put("/api/preferences", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Preferences are disabled (database unavailable)" });
    }
    const { key, value } = req.body || {};
    if (!key || typeof value === "undefined") {
      return res.status(400).json({ error: "Missing key or value" });
    }
    db.setPreference(key, value);
    res.json({ ok: true });
  });
}

// Static SPA serving + deep-link fallback. Must be registered after the app's
// /api routes and before the /external/:appId proxies (so dist files win).
export function registerStaticAndFallback(ctx) {
  const { app } = ctx;
  app.use(express.static(WEB_DIST));
  // SPA fallback: any GET that isn't an API route, proxy path, or static asset
  // serves index.html so the client router handles it. `assets/` stays excluded
  // so a missing bundle 404s instead of silently returning index.html.
  app.get(/^\/(?!api\/|external\/|assets\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
}

