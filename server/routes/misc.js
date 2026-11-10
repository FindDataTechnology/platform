// Misc routes: identity introspection, agent/app catalog, Nango connect
// broker, server config, supervisor status, preferences — plus the static SPA
// serving, registered separately (registerStaticAndFallback) so the
// composition root can place it after the app's /api routes.

import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
import fs from "node:fs";
import express from "express";
import { WEB_DIST } from "../context.js";
import { applySpaHeaders, SHELL_CACHE_CONTROL } from "../../lib/spa-static-headers.js";
import { storeDir } from "../../paths.js";
import { listProjects, upsertProjectByName, renameProject } from "../../db.js";
import * as taskEngine from "../../task-engine.js";
import { resolveWebsearchRelay, maskToken, getUserKey, setUserKey, clearUserKey } from "../../lib/websearch-relay.js";
import * as registryCredentials from "../../registry-credentials.js";
import * as connectorCredentials from "../../connector-credentials.js";
import * as facetMarketCredentials from "../../facet-market-credentials.js";
import * as lineCredentials from "../../line-credentials.js";
import * as paperTradingCredentials from "../../paper-trading-credentials.js";
import * as chatwootCredentials from "../../chatwoot-credentials.js";
import * as ciyuanAccountCredentials from "../../ciyuan-account-credentials.js";
import { resolveVoiceConfig } from "./voice.js";
import { copilotEnabled, lineBoardsEnabled } from "../../lib/board-adapters.js";
import { BUSINESS_ROLES, parseStoredAssignments, resolveAssignment } from "../roles.js";
import { registerOnboardingRoutes } from "./onboarding.js";
import {
  LAYOUT_CONFIG_KEY,
  deploymentLayer,
  mergeLayoutConfig,
  resolveForUser,
  userTweaks,
  validateLayoutConfig,
  writeUserTweaks,
} from "../layout.js";

// ── Workbench layout (layout-configuration) ──────────────────────────────────
// Deployment config (admin) + the user's own visibility/order adjustments
// (self). The resolved layout ships in /api/config; these routes are the
// editing faces. The gateway answers /api/layout/config on hosted deployments
// before the catch-all; this mount serves the local topology.
function registerLayoutRoutes(ctx) {
  const { app, db } = ctx;

  const storedConfig = () => {
    if (!db.isDbReady()) return {};
    try {
      const raw = db.getDeploymentConfig(LAYOUT_CONFIG_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      console.warn("[layout] stored layout config is not valid JSON; ignoring");
      return {};
    }
  };

  // Admin read of the deployment document (as stored, not the resolved view).
  app.get("/api/layout/config", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    const layer = deploymentLayer({ db });
    res.json({
      defaultPreset: layer.defaultPreset ?? null,
      rolePresets: layer.rolePresets ?? {},
      hidden: layer.hidden ?? [],
      presets: Object.keys(layer.presets ?? {}),
    });
  });

  // Admin write: partial patch merged onto the stored document. Validation is
  // whole-write-or-nothing (an unknown slug persists nothing).
  app.put("/api/layout/config", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    const result = validateLayoutConfig(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    const merged = mergeLayoutConfig(storedConfig(), result.config);
    db.setDeploymentConfig(LAYOUT_CONFIG_KEY, JSON.stringify(merged));
    res.json({
      defaultPreset: merged.defaultPreset ?? null,
      rolePresets: merged.rolePresets ?? {},
      hidden: merged.hidden ?? [],
      presets: Object.keys(merged.presets ?? {}),
    });
  });

  // The user's own tweaks (self; no admin gate — everyone adjusts their own
  // workbench within what the layers above left visible).
  // Identity scopes every read/write: the preference table is per-cell, and a
  // cell can host several identities — one user's workbench must never leak
  // into another's resolution.
  const emailOf = (req) => req.user?.email ?? null;

  app.get("/api/layout/preferences", (req, res) => {
    res.json({ tweaks: userTweaks({ db, email: emailOf(req) }) });
  });

  app.put("/api/layout/preferences", (req, res) => {
    const tweaks = req.body?.tweaks;
    if (tweaks !== null && (typeof tweaks !== "object" || Array.isArray(tweaks))) {
      return res.status(400).json({ error: "tweaks must be an object or null" });
    }
    writeUserTweaks({ db, email: emailOf(req) }, tweaks);
    res.json({ tweaks: userTweaks({ db, email: emailOf(req) }) });
  });

  // DELETE clears the adjustments (the restore control's server half).
  app.delete("/api/layout/preferences", (req, res) => {
    writeUserTweaks({ db, email: emailOf(req) }, null);
    res.json({ tweaks: null });
  });
}

// ── Business roles (role-system) ─────────────────────────────────────────────
// The cell-side REST face. On a hosted deployment the gateway answers these
// routes BEFORE the cell-proxy catch-all (the assignment document is
// deployment-level and lives there); this mount is the local/single-process
// implementation of the same contract, reading and writing its own
// deployment_config key. Either way the resolved assignment is what lands on
// req.user.roles, so every consumer sees one shape.
function registerRoleRoutes(ctx) {
  const { app, db } = ctx;

  const storedDoc = () => (db.isDbReady() ? parseStoredAssignments(db.getDeploymentConfig("roles.assignments")) : null);
  const writeStored = (doc) => db.setDeploymentConfig("roles.assignments", JSON.stringify(doc));
  const readAssignments = () => storedDoc() ?? { assignments: {}, default: null };
  const localRoster = () => {
    const doc = readAssignments();
    return [...new Set(Object.keys(doc.assignments))].sort();
  };

  // Enumeration — readable by any authenticated user (labels resolve client
  // side from the i18n bundle keyed by slug; the slug list is the contract).
  app.get("/api/roles", (_req, res) => {
    res.json({ roles: BUSINESS_ROLES, default: "standard" });
  });

  // Admin listing: every assigned user with their effective assignment.
  app.get("/api/roles/assignments", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    const doc = readAssignments();
    const emails = [...new Set([...localRoster(), ...Object.keys(doc.assignments)])].sort();
    res.json({
      assignments: emails.map((email) => ({
        email,
        ...resolveAssignment({ user: { email }, db, env: process.env }),
      })),
      default: doc.default ?? null,
    });
  });

  // Whole-assignment replace for one user. Admin-gated with the standard gate
  // (open when auth is off: the machine owner). Invalid payloads are 4xx with
  // nothing persisted.
  app.put("/api/roles/assignments/:userId", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    const email = String(req.params.userId || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return res.status(400).json({ error: "invalid user id" });
    const body = req.body || {};
    if (body.primary !== undefined && !BUSINESS_ROLES.includes(body.primary)) {
      return res.status(400).json({ error: `unknown role '${body.primary}'` });
    }
    const secondary = Array.isArray(body.secondary) ? body.secondary : [];
    const unknown = secondary.filter((s) => !BUSINESS_ROLES.includes(s));
    if (unknown.length) return res.status(400).json({ error: `unknown roles: ${unknown.join(", ")}` });
    const primary = body.primary ?? "standard";
    const assignment = { primary, secondary: [...new Set(secondary)].filter((s) => s !== primary), admin: body.admin === true };
    const doc = readAssignments();
    const neutral = assignment.primary === "standard" && !assignment.secondary.length && !assignment.admin;
    if (neutral) delete doc.assignments[email];
    else doc.assignments[email] = assignment;
    writeStored(doc);
    res.json({ email, ...resolveAssignment({ user: { email }, db, env: process.env }) });
  });
}

// Binding ledger projection for the connection-center card
// (add-connector-bindings 6.1). Token-free by construction: the fields below are
// copied one by one, so a ledger row growing a column can never leak it.
//
// `deprecated` rows (a binding the pack no longer declares) are listed — the
// card may want to say "this grant is orphaned" — but they are excluded from
// the counts, which answer "what does my installed set still need".
async function projectBindingLedger(email) {
  // The ledger is keyed by ownerKey, not by the raw identity: with auth off
  // there is no email and every credential module (and therefore every row the
  // user actually granted) lives under the machine-owner key. Dropping null
  // here skipped the projection entirely in exactly that deployment.
  const ownerEmail = connectorCredentials.ownerKey(email);
  if (!ownerEmail) return null;
  let bindings;
  try {
    bindings = await import("../../connector-bindings.js");
  } catch {
    return null; // module absent — the card simply has no binding view
  }
  let ledger;
  try {
    ledger = bindings.listBindings(email);
  } catch {
    return null; // no DB: absence of evidence, not "you have zero bindings"
  }
  if (!Array.isArray(ledger)) return null;
  // `granted` is asked of the credential, not inferred from the ledger: a row
  // can be satisfied and still un-granted, and the card has to offer "grant"
  // or "revoke" depending on exactly that. `grantedAt` is display only.
  const rows = ledger.map((row) => ({
    packId: row.packId,
    key: row.bindingKey,
    provider: row.provider,
    // A role binding exposes the role it stands for: `provider` is then the
    // system the user chose (null while unchosen), and the card needs the role
    // to offer "choose your system" against the right mapping.
    role: row.role ?? null,
    providerRole: Boolean(row.role),
    operations: Array.isArray(row.operations) ? [...row.operations] : [],
    status: row.status,
    optional: !!row.optional,
    granted: Boolean(bindings.liveBindingToken(email, row.packId, row.bindingKey)),
    grantedAt: row.grantedAt ?? null,
  }));
  const active = rows.filter((row) => row.status !== "deprecated" && row.status !== "undetermined");
  const packs = new Set(active.map((row) => row.packId));
  // "Unresolved" = the user (or the platform) still owes this binding something.
  // `undetermined` is excluded on purpose: it means we could not ask, and
  // counting an outage as work-to-do would be a lie in the other direction.
  const unresolved = active.filter((row) => !row.optional && row.status !== "satisfied").length;
  // "Unwired" is a separate count because it is a different promise: the user
  // cannot close these by connecting anything — the catalog does not cover what
  // the pack declares (connector-bindings spec, `unwired` MUST NOT degrade to
  // `missing`). The card renders it as a capability gap, not as a todo.
  const unwired = active.filter((row) => row.status === "unwired").length;
  // `unmapped` is its own count for the same reason `unwired` is: the fix is
  // "choose which system you run", not "connect something" and not "we don't
  // support it". It counts inside `unresolved` (the user owes a choice).
  const unmapped = active.filter((row) => row.status === "unmapped").length;
  return { rows, summary: { packs: packs.size, bindings: active.length, unresolved, unwired, unmapped } };
}

// Fleet fairness projection for the readiness probe. A throwing snapshot must
// read as "no fairness data", never as a broken queue: the probe's verdict is
// still queueHealth's job.
function safeFairnessSnapshot() {
  try {
    return taskEngine.queueFairnessSnapshot();
  } catch (e) {
    return { enabled: false, error: String(e?.message || e) };
  }
}

export function registerMiscRoutes(ctx) {
  const { app, catalog, db, cron } = ctx;
  registerRoleRoutes(ctx);
  registerLayoutRoutes(ctx);
  registerOnboardingRoutes(ctx);

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
      // The composed admin answer (role flag OR admin group) — the same
      // predicate ctx.requireAdmin uses, so the UI never disagrees with the
      // server about who is admin (role-system D3).
      isAdmin: ctx.isAdminUser?.(req.user) === true,
      roles: req.user?.roles ?? null,
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
  //
  // Queue liveness (fix-task-queue-deadlock D3): "agent ready" says nothing
  // about the execution queue draining. 2026-11-08 live: one task stuck
  // `running` for minutes with 22 `queued` behind it, while this probe kept
  // answering {"ready":true} — that false green turned one stall into hours of
  // misdiagnosis. A degraded queue now answers 503 and carries the numbers.
  app.get("/api/ready", (_req, res) => {
    const queue = taskEngine.queueHealth({ budgetOf: taskEngine.resolveBudgetFor });
    const ready = ctx.ready.dsh && !queue.degraded;
    res.status(ready ? 200 : 503).json({
      ready,
      // Set when agent init failed but the server degraded instead of dying
      // (win-install-smoke 2026-10-08) — lets probes distinguish "booting"
      // from "agent runtime unavailable".
      dshInitError: ctx.dshInitError ?? null,
      queue: {
        ...queue,
        // Fleet fairness (split-meta-team-queue-capacity): who is waiting and how
        // many slots each fleet took this rotation. Read-only extra — `ready` and
        // `degraded` are still decided by queueHealth alone, so the liveness
        // contract that fix-task-queue-deadlock landed is untouched.
        fairness: safeFairnessSnapshot(),
      },
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

  app.get("/api/config", (req, res) => {
    // The resolved layout (layout-configuration): the server composes all four
    // layers (factory/deployment/role/user) plus the facts it owns, and the
    // client renders straight from the answer — no layer precedence logic in
    // the browser. `desktopOnly` stays client-owned: the predicate list ships
    // and the client applies it at render (only it knows the shell).
    const { layout } = resolveForUser({
      db,
      email: req.user?.email ?? null,
      roles: req.user?.roles ?? null,
      gatewayLayout: req.user?.gatewayLayout ?? null,
      facts: {
        authOn: Boolean(ctx.authEnabled),
        isAdmin: ctx.isAdminUser?.(req.user) === true,
        packMarketplace: process.env.PACK_MARKETPLACE === "1",
        documentsEnabled: db.isDbReady(),
      },
    });
    res.json({
      documentsEnabled: db.isDbReady(),
      // Pack marketplace surfaces (add-pack-marketplace): shown only on
      // gateway-fronted deployments — the market/publish APIs live on the
      // gateway, which a local single-process deployment does not have.
      packMarketplace: process.env.PACK_MARKETPLACE === "1",
      // The viewer's business roles (role-system): the resolved assignment the
      // layout chain and onboarding consume. Null when no identity is attached
      // (anonymous/public read) — the web treats that as "no role data".
      roles: req.user?.roles ?? null,
      // The server-computed layout: per-container ordered visible slugs.
      resolvedLayout: layout,
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
      // Voice lane (voice-lane): the deployment-level switch and the TTS
      // container format, enough for the composer to decide at boot whether
      // to render voice entries at all. Key availability is per-user and
      // comes from /api/voice/status.
      voice: (() => {
        const v = resolveVoiceConfig();
        return { enabled: v.enabled, ttsFormat: v.ttsFormat };
      })(),
      // Line boards (add-wire-line-board D8): the deployment switch the web
      // reads to decide whether /boards/:line and the app-center board CTA
      // exist at all. Absent on older servers ⇒ the web treats it as off.
      lineBoardsEnabled: lineBoardsEnabled(),
      // Copilot dock kill switch (add-line-boards-and-action-gate 8.3). Absent
      // on older servers ⇒ the web treats it as on (the dock predates it).
      copilotEnabled: copilotEnabled(),
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
  // deployment credential. Secret-free by construction (the relay reports
  // token prefixes/scope ids only; the per-key cold-standby view was retired
  // with the direct path — retire-search-relay-direct).
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
        upstream: stats.upstream ?? null,
        overrides: stats.overrides ?? null,
        errors: stats.errors ?? null,
        uptimeSec: stats.uptimeSec ?? null,
      });
    } catch (err) {
      return res.json({ configured: true, reachable: false, detail: String(err?.message || err).slice(0, 200) });
    }
  });

  // ── Connection status aggregation (connection-center) ─────────────────────
  // Read-only projection of every connection the Settings connections section
  // renders. Whitelist projection by construction: each entry is built from
  // exactly the fields below, so credential material cannot leak into the
  // payload even if a module's status shape grows. Keyed to the requesting
  // identity like the per-credential routes; auth off = machine owner.
  app.get("/api/connections", async (req, res) => {
    const identity = req.ssoUser || req.user || null;
    const email = identity?.email ?? null;
    if (ctx.authEnabled && !email) {
      return res.status(401).json({ error: "Authentication is required" });
    }
    const entry = (id, name, state, reason = null) => ({ id, name, state, reason });

    const fromStatus = (id, name, s) => {
      if (s.connected) return entry(id, name, "connected");
      if (s.stale || s.expired) return entry(id, name, "stale", s.expired && !s.stale ? "expired" : "stale");
      return entry(id, name, "disconnected");
    };

    const items = [
      fromStatus("registry", "谦面·工具市场", registryCredentials.status(email)),
      fromStatus("facet-market", "谦面市场（设备配对）", facetMarketCredentials.status(email)),
    ];

    // Connector is multi-slot: any live slot counts as connected; slots that
    // all went stale still show as stale (reconnect, not first connect).
    const slots = connectorCredentials.listForClient(email);
    const connectorItem =
      slots.some((s) => s.connected)
        ? entry("connector", "萬星·连接器", "connected")
        : slots.length > 0
          ? entry("connector", "萬星·连接器", "stale", "stale")
          : entry("connector", "萬星·连接器", "disconnected");
    // Binding projection (add-connector-bindings 6.1): what the user's packs
    // DECLARE, resolved per binding, so the card can say "N packs need M
    // bindings, K unresolved" and deep-link each one. Built field-by-field on
    // purpose — a ledger row also carries the resolved connection id and the
    // grant's stamp, and neither belongs in a status payload.
    const bindings = await projectBindingLedger(email);
    if (bindings) {
      connectorItem.bindings = bindings.rows;
      connectorItem.bindingSummary = bindings.summary;
    }
    items.push(connectorItem);

    for (const [line, name] of [
      ["wire-customer", "柏讯（操作）"],
      ["lex", "识律（操作）"],
    ]) {
      items.push(fromStatus(`line-${line}`, name, lineCredentials.status(email, line)));
    }
    // 词元账号 (ciyuan-account-lane): replaces the retired line-wanxing-caller entry —
    // the account key (or a legacy pasted caller key) is one connection, one card.
    items.push(fromStatus("ciyuan-account", "萬星·词元", ciyuanAccountCredentials.status(email)));
    items.push(fromStatus("paper-trading", "柏讯·模拟交易", paperTradingCredentials.status(email)));
    // 商家 Chatwoot BYOK（add-crm-desk-pack-embed）：粘贴 token(+嵌入用登录对)。
    items.push(fromStatus("chatwoot", "CRM 客服台（自带 Chatwoot）", chatwootCredentials.status(email)));

    // Search: the user's own key serves first, then the deployment's shared
    // relay. Admins additionally get the pool health summary (same source as
    // /api/config/websearch/pool, bounded probe).
    const userKey = getUserKey(db, email);
    const { url, token } = await resolveWebsearchRelay(db);
    const search = userKey
      ? entry("search", "搜索服务", "connected", "user-key")
      : url && token
        ? entry("search", "搜索服务", "connected", "shared-pool")
        : entry("search", "搜索服务", "not-configured");
    search.userKey = Boolean(userKey);
    const isAdmin = !ctx.authEnabled || ctx.isAdminUser?.(req.user);
    if (isAdmin) {
      search.shared = { configured: Boolean(url && token) };
      if (url && token) {
        try {
          const upstream = await fetch(`${url.replace(/\/+$/, "")}/v1/stats`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
          });
          search.shared.reachable = upstream.ok;
          if (upstream.ok) {
            const stats = await upstream.json();
            search.shared.upstreamMode = stats.upstream?.mode ?? null;
          }
        } catch {
          search.shared.reachable = false;
        }
      }
    }
    items.push(search);

    res.json({ connections: items });
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

  // ── Gateway-internal: queue health ────────────────────────────────────────
  // The gateway aggregates this across resident cells for /readyz, because the
  // queue lives in each cell's task engine and the public /api/ready is behind
  // the gateway's own auth (measured 2026-11-08: 401 from inside the pod, so no
  // k8s probe could ever read it). Only the summary leaves here — no job
  // prompts, no ids, nothing user-identifying.
  app.get("/api/gateway/queue", (_req, res) => {
    try {
      const queue = taskEngine.queueHealth({ budgetOf: taskEngine.resolveBudgetFor });
      res.json({
        queued: queue.queued ?? 0,
        running: queue.running ?? 0,
        oldestQueuedMs: queue.oldestQueuedMs ?? null,
        oldestRunningMs: queue.oldestRunningMs ?? null,
        overBudget: queue.overBudget ?? 0,
        // Rounds waiting by design because dropping them would lose a whole
        // period (fix-stale-drop-respects-period). Without this field,
        // `oldestQueuedMs: null` with `queued > 0` is ambiguous to an operator:
        // it can mean "only exempt rounds are queued" or "no cell answered".
        queuedExempt: queue.queuedExempt ?? 0,
        degraded: queue.degraded === true,
      });
    } catch (e) {
      // A broken projection must not read as "healthy queue".
      res.status(500).json({ error: `queue health unavailable: ${e?.message || e}` });
    }
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

  // ── Per-server full-surface override (full-mode-tool-scope B3) ────────────
  // One GLOBAL preference (not per-preset): the servers the user wants at
  // their complete tool surface, in full AND focused modes. The marker is a
  // removal from the derived filter — an empty array clears it (the key is
  // deleted, so "never set" and "cleared" are the same state). Composition
  // picks the change up on the next derivation (boot / preset switch / MCP
  // change); this route never touches the runtime directly.
  app.get("/api/mcp-tool-scope", (_req, res) => {
    res.json({ fullSurface: db.isDbReady() ? db.getFullSurfaceServers() : [] });
  });

  app.put("/api/mcp-tool-scope", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Preferences are disabled (database unavailable)" });
    }
    const list = req.body?.fullSurface;
    if (!Array.isArray(list) || list.some((s) => typeof s !== "string" || !s)) {
      return res.status(400).json({ error: "fullSurface must be an array of server names" });
    }
    res.json({ fullSurface: db.setFullSurfaceServers(list) });
  });

  // ── Projects (add-web-project-container) ─────────────────────────────────
  // A project is the web-side top-level container with identity (id + display
  // name); `backing_path` is the engine directory the set_workspace switch
  // already produces — the runtime is never touched here. POST creates the
  // directory AND a project row in one shot and returns the stable id, so the
  // client can stamp sessions/collections/jobs with it. Re-POSTing an existing
  // name attaches (returns the existing id) rather than duplicating. PROJECTS_ROOT
  // overrides the default (<dataDir>/projects).
  app.post("/api/projects", (req, res) => {
    const raw = typeof req.body?.name === "string" ? req.body.name : "";
    if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
      return res.status(400).json({ error: "项目名不能包含路径符号" });
    }
    const sanitized = raw
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\p{Script=Han}\p{L}\p{N}_-]/gu, "")
      .replace(/^[.\-]+/, "")
      .slice(0, 64);
    if (!sanitized) {
      return res.status(400).json({ error: "项目名不能为空（仅支持中英文、数字、- 和 _）" });
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
    const project = upsertProjectByName(sanitized, dir);
    if (!project) {
      return res.status(500).json({ error: "写入项目记录失败" });
    }
    res.json({ id: project.id, path: project.path, name: project.name, attached: project.attached });
  });

  // List the caller's projects (id + name + backing path) for the web sidebar's
  // project grouping and the collection/job pickers. Read-only over the same
  // projects store POST/PATCH write.
  app.get("/api/projects", (_req, res) => {
    res.json({ projects: listProjects() });
  });

  // Rename a project's display name. Identity (id) and backing path never
  // move — existing session/collection attributions keyed by id stay valid.
  app.patch("/api/projects/:id", (req, res) => {
    const id = req.params?.id;
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
    if (!renameProject(id, sanitized)) {
      return res.status(404).json({ error: "项目不存在" });
    }
    res.json({ id, name: sanitized });
  });
}

// Static SPA serving + deep-link fallback. Must be registered after the app's
// /api routes and before the /external/:appId proxies (so dist files win).
export function registerStaticAndFallback(ctx) {
  const { app } = ctx;
  // Chart rendering assets for the mobile client's WebView (ChartView). The
  // universal app renders charts inside a WebView, and that WebView cannot
  // reach a CDN in CI/offline deployments — nor can it hold a 1MB inline copy
  // (the emulator's renderer process crashed on it, 2026-10-28). Serving the
  // library from the platform the app is already paired to keeps charts
  // same-origin, offline and out of the JS bundle.
  app.get("/chart-assets/echarts.min.js", (_req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, "resources", "chart-assets", "echarts.min.js"), {
      headers: { "cache-control": "public, max-age=31536000, immutable" },
    });
  });
  // Cache posture (openspec: harden-spa-shell-resilience): shell revalidates,
  // hashed assets live forever — same leaf module the gateway uses, so the
  // two servers cannot drift.
  app.use(express.static(WEB_DIST, { setHeaders: (res, filePath) => applySpaHeaders(res, filePath) }));
  // SPA fallback: any GET that isn't an API route, proxy path, or static asset
  // serves index.html so the client router handles it. `assets/` stays excluded
  // so a missing bundle 404s instead of silently returning index.html.
  app.get(/^\/(?!api\/|external\/|assets\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"), { headers: { "Cache-Control": SHELL_CACHE_CONTROL } });
  });
}

