// Misc routes: identity introspection, agent/app catalog, Nango connect
// broker, server config, supervisor status, preferences — plus the static SPA
// serving, registered separately (registerStaticAndFallback) so the
// composition root can place it after the app's /api routes.

import path from "node:path";
import fs from "node:fs";
import express from "express";
import { WEB_DIST } from "../context.js";
import { storeDir } from "../../paths.js";
import { resolveWebsearchRelay, maskToken, getUserKey, setUserKey, clearUserKey } from "../../lib/websearch-relay.js";

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
    res.status(ctx.ready.dsh ? 200 : 503).json({
      ready: ctx.ready.dsh,
      // Set when agent init failed but the server degraded instead of dying
      // (win-install-smoke 2026-10-08) — lets probes distinguish "booting"
      // from "agent runtime unavailable".
      dshInitError: ctx.dshInitError ?? null,
    });
  });

  // ── Server config (documents state, deployment branding) ──────────────────
  // Branding resolution: stored (SQLite) → env → null. The web falls back to
  // localized defaults for each null field.
  const brandingField = (key, envName) => {
    const stored = db.isDbReady() ? db.getDeploymentConfig(key) : null;
    if (stored !== null && stored !== undefined) return stored;
    return (process.env[envName] || "").trim() || null;
  };

  // loginHero (openspec: add-login-hero) — the one structured branding field.
  // Locale keys are the closed set of supported UI locales; kept in lockstep
  // with web/src/i18n/config.ts (SUPPORTED_LOCALES) — scripts/test-login-hero.mjs
  // asserts the two sets match.
  const LOGIN_HERO_LOCALES = ["en", "zh-CN", "es", "fr", "ja"];
  const loginHeroBounds = { title: 120, subtitle: 200, point: 120, points: 4, linkLabel: 40, url: 500, links: 4 };

  // Structural validation → { ok, error } | { ok, normalized }. Normalized
  // output trims strings and drops absent sub-fields so the stored JSON is
  // canonical for both the store and the env fallback.
  const validateLoginHero = (value) => {
    const fail = (error) => ({ ok: false, error });
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("Field 'loginHero' must be an object keyed by locale");
    }
    const locales = Object.keys(value);
    if (!locales.length) return fail("Field 'loginHero' must carry at least one locale entry");
    const normalized = {};
    for (const locale of locales) {
      if (!LOGIN_HERO_LOCALES.includes(locale)) {
        return fail(`Field 'loginHero' has an unsupported locale key '${locale}'`);
      }
      const entry = value[locale];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return fail(`Field 'loginHero.${locale}' must be an object`);
      }
      const out = {};
      for (const field of ["title", "subtitle", "imageUrl"]) {
        if (!Object.hasOwn(entry, field)) continue;
        const v = entry[field];
        const bound = field === "title" ? loginHeroBounds.title : field === "subtitle" ? loginHeroBounds.subtitle : loginHeroBounds.url;
        if (typeof v !== "string") return fail(`Field 'loginHero.${locale}.${field}' must be a string`);
        const s = v.trim();
        if (s.length > bound) return fail(`Field 'loginHero.${locale}.${field}' exceeds ${bound} characters`);
        if (s) {
          if (field === "imageUrl" && !/^https?:\/\//.test(s)) {
            return fail(`Field 'loginHero.${locale}.${field}' must be an http(s):// URL`);
          }
          out[field] = s;
        }
      }
      if (Array.isArray(entry.points)) {
        if (entry.points.length > loginHeroBounds.points) {
          return fail(`Field 'loginHero.${locale}.points' exceeds ${loginHeroBounds.points} items`);
        }
        const points = [];
        for (const p of entry.points) {
          if (typeof p !== "string") return fail(`Field 'loginHero.${locale}.points' items must be strings`);
          const s = p.trim();
          if (s.length > loginHeroBounds.point) {
            return fail(`Field 'loginHero.${locale}.points' items exceed ${loginHeroBounds.point} characters`);
          }
          if (s) points.push(s);
        }
        if (points.length) out.points = points;
      }
      if (Array.isArray(entry.links)) {
        if (entry.links.length > loginHeroBounds.links) {
          return fail(`Field 'loginHero.${locale}.links' exceeds ${loginHeroBounds.links} items`);
        }
        const links = [];
        for (const l of entry.links) {
          if (typeof l !== "object" || l === null || Array.isArray(l)) {
            return fail(`Field 'loginHero.${locale}.links' items must be {label, url} objects`);
          }
          const label = typeof l.label === "string" ? l.label.trim() : "";
          const url = typeof l.url === "string" ? l.url.trim() : "";
          if (!label || label.length > loginHeroBounds.linkLabel) {
            return fail(`Field 'loginHero.${locale}.links[].label' must be a non-empty string of at most ${loginHeroBounds.linkLabel} characters`);
          }
          if (!/^https?:\/\//.test(url) || url.length > loginHeroBounds.url) {
            return fail(`Field 'loginHero.${locale}.links[].url' must be an http(s):// URL of at most ${loginHeroBounds.url} characters`);
          }
          links.push({ label, url });
        }
        if (links.length) out.links = links;
      }
      if (!Object.keys(out).length) {
        return fail(`Field 'loginHero.${locale}' carries no content (need at least one of title/subtitle/points/imageUrl/links)`);
      }
      normalized[locale] = out;
    }
    return { ok: true, normalized };
  };

  // Stored JSON → env JSON → null. An unparseable or invalid source degrades
  // to null with a warning: a bad hand-written LOGIN_HERO must never take the
  // login page (or the server) down.
  const loginHeroField = () => {
    const raw = db.isDbReady() ? db.getDeploymentConfig("loginHero") : null;
    const source = raw !== null && raw !== undefined && String(raw).trim() ? String(raw) : (process.env.LOGIN_HERO || "").trim() || null;
    if (!source) return null;
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      console.warn("[branding] loginHero source is not valid JSON; ignoring");
      return null;
    }
    const result = validateLoginHero(parsed);
    if (!result.ok) {
      console.warn(`[branding] loginHero source failed validation (${result.error}); ignoring`);
      return null;
    }
    return result.normalized;
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
      loginHero: loginHeroField(),
      // Capability probe for non-browser clients (add-device-pairing-auth):
      // absent on older deployments, which clients read as "unsupported".
      // devicePairing rides the same MP_TOKEN_SECRET gate as the
      // mini-program path.
      capabilities: { devicePairing: Boolean(process.env.MP_TOKEN_SECRET) },
    });
  });

  // ── Branding write (admin-gated; open when auth off) ──────────────────────
  // Full-replace of provided fields: omitted = unchanged, empty string = clear
  // back to the env fallback. All strings capped at 200 chars; brandIconUrl
  // must be http(s):// when non-empty. loginHero (structured) validates as a
  // whole before anything is persisted; null / "" / {} clear it.
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
    let heroUpdate; // undefined = absent (untouched), null = clear, object = set
    if (Object.hasOwn(body, "loginHero")) {
      const value = body.loginHero;
      if (value === null || value === "" || (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)) {
        heroUpdate = null;
      } else {
        const result = validateLoginHero(value);
        if (!result.ok) return res.status(400).json({ error: result.error });
        heroUpdate = result.normalized;
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === "") db.clearDeploymentConfig(key);
      else db.setDeploymentConfig(key, value);
    }
    if (heroUpdate !== undefined) {
      // heroUpdate: null = clear (back to env fallback), object = store.
      if (heroUpdate === null) db.clearDeploymentConfig("loginHero");
      else db.setDeploymentConfig("loginHero", JSON.stringify(heroUpdate));
    }
    res.json({ ok: true });
  });

  // ── Web search relay wiring (add-websearch-settings) ─────────────────────
  // Settings → Network search. The relay pair (URL + token) resolves
  // stored→env (lib/websearch-relay.js); writes land in deployment_config and
  // hot-rewrite the MCP patch so cells pick the new wiring up without a
  // restart. Tokens are write-only: responses carry presence + a 4-char hint,
  // never the value. Same admin gate as the other management surfaces
  // (auth off = machine owner).
  const requireWebsearchManage = (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser?.(req.user)) {
      res.status(403).json({ error: "Admin group required" });
      return false;
    }
    return true;
  };

  app.get("/api/config/websearch", async (_req, res) => {
    const { url, token, source } = await resolveWebsearchRelay(db);
    res.json({
      url: url ?? "",
      hasToken: Boolean(token),
      tokenHint: maskToken(token),
      source,
    });
  });

  app.put("/api/config/websearch", async (req, res) => {
    if (!requireWebsearchManage(req, res)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Web search settings are disabled (database unavailable)" });
    }
    const body = req.body || {};
    // Absent field = untouched; "" = clear (back to env); non-empty = store.
    for (const [field, key] of [["url", "websearchUrl"], ["token", "websearchToken"]]) {
      if (!Object.hasOwn(body, field)) continue;
      const value = body[field];
      if (typeof value !== "string") return res.status(400).json({ error: `Field '${field}' must be a string` });
      const trimmed = value.trim();
      if (field === "url" && trimmed && !/^https?:\/\//.test(trimmed)) {
        return res.status(400).json({ error: "url must be an http(s):// URL" });
      }
      if (trimmed.length > 500) return res.status(400).json({ error: `Field '${field}' exceeds 500 characters` });
      if (trimmed === "") db.clearDeploymentConfig(key);
      else db.setDeploymentConfig(key, trimmed);
    }
    // Hot-rewrite the MCP patch so a running cell re-resolves the envRefs on
    // its next composition (same path the extensions routes use). The token
    // VALUE never appears in logs — only the fact that wiring changed.
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined)
      .catch((e) => console.warn(`[websearch-config] MCP patch rewrite failed: ${e.message}`));
    console.log("[websearch-config] relay wiring updated (values redacted)");
    const { url, token, source } = await resolveWebsearchRelay(db);
    res.json({ ok: true, url: url ?? "", hasToken: Boolean(token), tokenHint: maskToken(token), source });
  });

  app.post("/api/config/websearch/test", async (req, res) => {
    if (!requireWebsearchManage(req, res)) return;
    const body = req.body || {};
    // Form values override the effective pair for a dry run — nothing persists.
    const effective = await resolveWebsearchRelay(db);
    const url = (typeof body.url === "string" && body.url.trim()) || effective.url;
    const token = (typeof body.token === "string" && body.token.trim()) || effective.token;
    // Admin dry-run may also exercise a user key (the caller's stored one by
    // default) so the result can disclose which credential served it.
    const userKey = (typeof body.userKey === "string" && body.userKey.trim()) || getUserKey(db, req.user?.email) || null;
    if (!url) return res.json({ state: "invalid-url", detail: "no relay URL configured" });
    if (!/^https?:\/\//.test(url)) return res.json({ state: "invalid-url", detail: "relay URL must be http(s)://" });
    if (!token) return res.json({ state: "auth-rejected", detail: "no relay token configured" });
    const base = url.replace(/\/+$/, "");
    try {
      const upstream = await fetch(`${base}/v1/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(userKey ? { "x-serpapi-key": userKey } : {}),
        },
        body: JSON.stringify({ query: "connectivity test", num: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      const source = upstream.headers.get("x-search-source") || undefined;
      if (upstream.ok) return res.json({ state: "ok", detail: `HTTP ${upstream.status}`, source });
      if (upstream.status === 401 || upstream.status === 403) {
        return res.json({ state: "auth-rejected", detail: `HTTP ${upstream.status}` });
      }
      // 5xx etc.: auth passed (the relay answered), upstream is degraded —
      // report it as such rather than mislabeling the wiring.
      return res.json({ state: "upstream-degraded", detail: `HTTP ${upstream.status}`, source });
    } catch (err) {
      const msg = err?.name === "TimeoutError" || err?.name === "AbortError"
        ? "timed out after 5s"
        : String(err?.message || err).slice(0, 200);
      return res.json({ state: "unreachable", detail: msg });
    }
  });

  // ── Per-user search key (add-search-byok) ────────────────────────────────
  // Any authenticated user manages their OWN key; the email comes from the
  // request identity, never from the client (no cross-user writes). Write-only
  // like the deployment token: responses carry presence + a 4-char hint.
  app.get("/api/config/websearch/userkey", (req, res) => {
    const key = getUserKey(db, req.user?.email);
    res.json({ hasKey: Boolean(key), keyHint: maskToken(key) });
  });

  app.put("/api/config/websearch/userkey", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Search settings are disabled (database unavailable)" });
    }
    const body = req.body || {};
    if (Object.hasOwn(body, "key")) {
      const value = body.key;
      if (typeof value !== "string") return res.status(400).json({ error: "Field 'key' must be a string" });
      const trimmed = value.trim();
      if (trimmed.length > 500) return res.status(400).json({ error: "Field 'key' exceeds 500 characters" });
      if (trimmed === "") clearUserKey(db, req.user?.email);
      else setUserKey(db, req.user?.email, trimmed);
    }
    // Same hot-rewrite as the deployment wiring: this user's next patch
    // composition carries (or drops) SEARCH_USER_KEY.
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined)
      .catch((e) => console.warn(`[websearch-config] MCP patch rewrite failed: ${e.message}`));
    console.log("[websearch-config] user search key updated (value redacted)");
    const key = getUserKey(db, req.user?.email);
    res.json({ ok: true, hasKey: Boolean(key), keyHint: maskToken(key) });
  });

  // Shared pool health (admin): proxy the relay's own stats with the effective
  // deployment credential. Secret-free by construction (the relay reports key
  // indexes/prefixes only).
  app.get("/api/config/websearch/pool", async (req, res) => {
    if (!requireWebsearchManage(req, res)) return;
    const { url, token } = await resolveWebsearchRelay(db);
    if (!url || !token) return res.json({ configured: false });
    try {
      const upstream = await fetch(`${url.replace(/\/+$/, "")}/v1/stats`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) return res.json({ configured: true, reachable: false, detail: `HTTP ${upstream.status}` });
      const stats = await upstream.json();
      return res.json({
        configured: true,
        reachable: true,
        day: stats.day,
        dailyCap: stats.dailyCap,
        keys: Array.isArray(stats.keys) ? stats.keys : [],
        overrides: stats.overrides ?? null,
        errors: stats.errors ?? null,
        uptimeSec: stats.uptimeSec ?? null,
      });
    } catch (err) {
      return res.json({ configured: true, reachable: false, detail: String(err?.message || err).slice(0, 200) });
    }
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

  // ── Projects (add-projects-automation-flow) ───────────────────────────────
  // Name-based project creation: the client sends a display name, the server
  // materializes a directory under the projects root and returns its absolute
  // path for the EXISTING set_workspace switch — the runtime is never touched
  // here. PROJECTS_ROOT overrides the default (<dataDir>/projects).
  app.post("/api/projects", (req, res) => {
    const raw = typeof req.body?.name === "string" ? req.body.name : "";
    const sanitized = raw
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\p{Script=Han}\p{L}\p{N}_-]/gu, "")
      .replace(/^[.\-]+/, "")
      .slice(0, 64);
    if (!sanitized) {
      return res.status(400).json({ error: "项目名不能为空（仅支持中英文、数字、- 和 _）" });
    }
    if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
      return res.status(400).json({ error: "项目名不能包含路径符号" });
    }
    const root = storeDir("projects", process.env.PROJECTS_ROOT);
    const dir = path.join(root, sanitized);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: "同名文件已存在，请换一个项目名" });
      }
    } catch (err) {
      return res.status(500).json({ error: `创建项目目录失败：${err.message}` });
    }
    res.json({ path: dir, name: sanitized });
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

