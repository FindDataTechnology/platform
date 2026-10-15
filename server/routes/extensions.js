// Extensions management API (MCP servers + custom skills).

import { getFileSkills } from "../skills.js";
import { getMarketEntries, getSkillContent } from "../../registry-bridge.js";
import * as credentialRefs from "../../credential-refs.js";
import { getPreflightStatus } from "../../mcp-preflight.js";
import { createExternalSourceRegistry, requestedPageSize } from "../../external-sources.js";
import { previewInstall, performInstall } from "../../external-install.js";
import { previewUpload, performUpload, seedUpload } from "../../skill-package-upload.js";

export function registerExtensionRoutes(ctx) {
  const { app, db, extensionStore, skillMaterialize, broadcast } = ctx;
  const bundle = ctx.bundle;

  // External skill-source mirror (add-external-skill-sources 刀一): the shelf
  // endpoints never touch the database, the skill store, or the
  // materialization tree; their only state is the snapshot cache inside the
  // registry. Same read posture as the market catalog GET (viewer-aware, no
  // admin gate). 刀二 adds TWO install endpoints whose consent gate lives
  // SERVER-SIDE (a direct API call without `confirm` is refused — the UI
  // panel is the explanation, not the enforcement). `ctx.externalSources` is
  // a test seam; production leaves it unset and the registry builds from env.
  const externalSources = ctx.externalSources ?? createExternalSourceRegistry({ env: process.env });
  const pageSize = () => requestedPageSize(process.env.EXTERNAL_SOURCE_PAGE_SIZE);

  // Map an install/preview failure's `.code` to an HTTP status; anything
  // unmapped is a 502 (upstream-facing by default, never a silent 200).
  const externalErrorStatus = (err) =>
    err?.status ?? (
      err?.code === "upstream-not-found" ? 502
      : err?.code === "limit-exceeded" ? 422
      : err?.code === "invalid-package" ? 422
      : err?.code === "invalid-name" ? 422
      : err?.code === "name-conflict" ? 409
      : err?.code === "unknown-source" ? 404
      : err?.code === "upstream-host-rejected" ? 502
      : 502
    );

  const requireMcpManage = (req, res) => {
    if (!ctx.requireMcpManage(req, res)) return false;
    return true;
  };

  // List all MCP server configurations (from database).
  app.get("/api/extensions/mcp", (_req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const servers = extensionStore.listMcpServers();
    res.json({ servers });
  });

  // MCP preflight health signal (add-mcp-credential-hygiene): the per-server
  // ok/auth-rejected/server-error/unreachable/unknown verdict from the last
  // patch composition. Read-only, same auth gate as the config list — the
  // "installed + enabled but zero tools" state stops being undiagnosable.
  app.get("/api/diagnostics/mcp", (_req, res) => {
    res.json({ servers: getPreflightStatus() });
  });

  // Add a new MCP server configuration.
  app.post("/api/extensions/mcp", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    if (!requireMcpManage(req, res)) return;
    const { name, config: submitted, enabled } = req.body || {};
    if (!name || !submitted) {
      return res.status(400).json({ error: "Missing name or config" });
    }
    // `credentialRef` is system-managed (add-connector-credentials D8): a
    // client-stamped ref could route the requester's own stored credential to
    // an arbitrary URL or wedge resolution on an unknown name. Only the
    // platform stamps it (market installs); operators declare refs in mcp.json.
    if (submitted.credentialRef !== undefined) {
      return res.status(400).json({ error: "credentialRef is system-managed; remove it from the submitted config" });
    }
    // Market install admission (design D3): resolve the merged catalog entry
    // by the submitted name. A gated entry requires the requester's groups to
    // intersect and stamps requiredGroups onto the record for runtime
    // filtering. No catalog match (hand-entered config) or no groups ⇒
    // ungated, exactly the pre-change behavior. Auth off = machine owner ⇒
    // unrestricted, still stamped.
    let requiredGroups = null;
    const entry = await extensionStore.findMarketMcpEntry(name);
    if (entry?.groups?.length) {
      requiredGroups = entry.groups;
      if (ctx.authEnabled && !(req.user?.groups ?? []).some((g) => requiredGroups.includes(g))) {
        return res.status(403).json({ error: `MCP server "${name}" requires one of groups: ${requiredGroups.join(", ")}` });
      }
    }
    // Registry-origin installs are credential-shaped (registry-sso-credentials,
    // extended by add-facet-market-credentials D4 / add-paper-trading-credentials):
    // the record references the installer's stored credential for the ref the
    // registering line declared (metadata.credential_ref — "registry",
    // "facet-market", "paper-trading", …), and the Authorization header is
    // resolved at profile-write time. Installing without a live credential for
    // THAT ref is refused — storing the template's placeholder would create a
    // server that can never authenticate, and judging by the wrong ref's
    // liveness would wire one service's token into another. The UI routes the
    // user to the connect flow for the named ref and retries.
    let config = submitted;
    if (entry?.origin === "registry") {
      const refName = credentialRefs.credentialRefForEntry(entry);
      if (!credentialRefs.credentialConnected(refName, req.user?.email ?? null)) {
        return res.status(409).json({
          error: `Connect the required credential before installing this server (${credentialRefs.credentialMissingReason(refName)})`,
          code: "credential-required",
          ref: refName,
        });
      }
      const { headers: _placeholderHeaders, ...rest } = submitted;
      config = { ...rest, credentialRef: refName };
    }
    try {
      const server = extensionStore.addMcpServer({ name, config, enabled, requiredGroups });
      // broadcast immediately so the UI refreshes right away, then
      // connect in the background. The connection attempt can take up to 10s
      // (timeout); we don't want to block the UI on it. The config is already
      // saved; the connection is best-effort.
      broadcast({ type: "extensions_changed", resource: "mcp", action: "added", name });
      res.json(server);
      ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
    } catch (err) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(409).json({ error: `MCP server "${name}" already exists` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Update an MCP server configuration.
  app.put("/api/extensions/mcp/:name", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    if (!requireMcpManage(req, res)) return;
    const { name } = req.params;
    const { config, enabled } = req.body || {};
    try {
      const oldServer = extensionStore.getMcpServer(name);
      if (!oldServer) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      if (oldServer.locked) {
        return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be updated` });
      }
      // Same system-managed-field gate as the add path (D8): an update is just
      // a slower way to stamp a ref the client must not control.
      if (config?.credentialRef !== undefined) {
        return res.status(400).json({ error: "credentialRef is system-managed; remove it from the submitted config" });
      }
      const server = extensionStore.updateMcpServer(name, { config, enabled });
      // Hot-reload: disconnect old, connect new if config changed or enabled changed.
      const configChanged = config && JSON.stringify(config) !== JSON.stringify(oldServer.config);
      const enabledChanged = enabled !== undefined && enabled !== oldServer.enabled;
      if (configChanged || enabledChanged) {
        // dsh owns MCP connections via the profile; rewrite the watched patch so
        // cordis HMR hot-swaps dsh-mcp-client (no restart on the primary path).
        ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
        broadcast({ type: "extensions_changed", resource: "mcp", action: "updated", name });
      }
      res.json(server);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove an MCP server configuration.
  app.delete("/api/extensions/mcp/:name", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    if (!requireMcpManage(req, res)) return;
    const { name } = req.params;
    const server = extensionStore.getMcpServer(name);
    if (!server) {
      return res.status(404).json({ error: `MCP server "${name}" not found` });
    }
    if (server.locked) {
      return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be removed` });
    }
    extensionStore.removeMcpServer(name);
    broadcast({ type: "extensions_changed", resource: "mcp", action: "removed", name });
    res.json({ ok: true });
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
  });

  // Enable or disable an MCP server.
  app.patch("/api/extensions/mcp/:name/enable", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    if (!requireMcpManage(req, res)) return;
    const { name } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Missing enabled (boolean)" });
    }
    const server = extensionStore.getMcpServer(name);
    if (!server) {
      return res.status(404).json({ error: `MCP server "${name}" not found` });
    }
    if (server.locked) {
      return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be disabled` });
    }
    const updated = extensionStore.toggleMcpServer(name, enabled);
    // broadcast + respond immediately; update (dsh hot-swap) in background.
    broadcast({ type: "extensions_changed", resource: "mcp", action: "toggled", name, enabled });
    res.json(updated);
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
  });

  // List all skills (file-based + custom from database).
  // File skills are not DB rows; their extension metadata is derived from the
  // bundle manifest: names in manifest `skills` are "bundled" and take
  // locked/permissions from the manifest's permissions map ("skill:<name>").
  app.get("/api/extensions/skills", async (_req, res) => {
    const fileSkills = getFileSkills().map((s) => {
      const bundled = bundle.skills.includes(s.name);
      const policy = bundled ? ctx.splitPolicy(bundle.permissions[`skill:${s.name}`]) : { locked: false, permissions: null };
      return {
        name: s.name,
        description: s.description,
        source: "file",
        enabled: true,
        origin: bundled ? "bundled" : "file",
        locked: policy.locked,
        permissions: policy.permissions,
      };
    });
    const customSkills = db.isDbReady()
      ? extensionStore.listCustomSkills().map((s) => ({
          name: s.name,
          description: s.description,
          source: "database",
          enabled: s.enabled,
          origin: "user",
          locked: false,
          permissions: null,
          // add-external-skill-install (刀二 3.4): auxiliary file PATHS only
          // (contents stay server-side) + external provenance when present;
          // both null/absent for every legacy single-file row.
          files: s.files ? Object.keys(s.files) : null,
          originMeta: s.originMeta ?? null,
        }))
      : [];
    res.json({ skills: [...fileSkills, ...customSkills] });
  });

  // Add a new custom skill — multipart channel first (add-packaged-skills D7,
  // entry 1): a zip package uploads as `file` with mode=preview|install.
  // Non-multipart requests fall through to the legacy JSON path untouched.
  // Same parse pipeline and limits as the external install line; the script
  // consent gate is enforced server-side inside performUpload.
  const uploadSkillPackage = ctx.upload ? ctx.upload.single("file") : null;
  app.post("/api/extensions/skills", (req, res, next) => {
    if (!String(req.headers["content-type"] ?? "").startsWith("multipart/form-data")) return next();
    if (!uploadSkillPackage) {
      return res.status(501).json({ error: "Skill package uploads are not available on this deployment" });
    }
    uploadSkillPackage(req, res, (err) => {
      if (err) return res.status(400).json({ error: `Upload rejected: ${err.message}` });
      if (!req.file) return res.status(400).json({ error: "Missing file field (the skill package zip)" });
      const mode = ["install", "seed"].includes(req.body?.mode) ? req.body.mode : "preview";
      const finish = (out) => {
        if (mode === "install") {
          broadcast({ type: "extensions_changed", resource: "skill", action: out.replaced ? "updated" : "added", name: out.skill.name });
        }
        res.json(mode === "install"
          ? {
            skill: {
              name: out.skill.name,
              description: out.skill.description,
              fileCount: out.skill.files ? Object.keys(out.skill.files).length : 0,
              originMeta: out.skill.originMeta,
            },
            replaced: out.replaced,
          }
          : mode === "seed" ? { seed: out } : { preview: out });
      };
      if (mode === "install") {
        if (!db.isDbReady()) {
          return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
        }
        performUpload({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          fields: req.body ?? {},
          store: extensionStore,
          materialize: skillMaterialize,
          dbReady: () => db.isDbReady(),
        }).then(finish, (err) => {
          res.status(externalErrorStatus(err)).json({ error: `Package upload failed: ${err.message}`, code: err.code ?? null });
        });
      } else if (mode === "seed") {
        seedUpload({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          fields: req.body ?? {},
        }).then(finish, (err) => {
          res.status(externalErrorStatus(err)).json({ error: `Package upload failed: ${err.message}`, code: err.code ?? null });
        });
      } else {
        previewUpload({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          fields: req.body ?? {},
        }).then(finish, (err) => {
          res.status(externalErrorStatus(err)).json({ error: `Upload preview failed: ${err.message}`, code: err.code ?? null });
        });
      }
    });
  });

  // Add a new custom skill (legacy JSON path, unchanged).
  app.post("/api/extensions/skills", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const { name, description, content, enabled } = req.body || {};
    if (!name || !content) {
      return res.status(400).json({ error: "Missing name or content" });
    }
    try {
      const skill = extensionStore.addCustomSkill({ name, description, content, enabled });
      // Materialize as SKILL.md so dsh-skill-filesystem hot-loads it (no restart).
      try { skillMaterialize.writeSkill(skill); } catch (e) { console.warn(`[skills] materialize write failed for "${name}": ${e.message}`); }
      broadcast({ type: "extensions_changed", resource: "skill", action: "added", name });
      res.json(skill);
    } catch (err) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(409).json({ error: `Skill "${name}" already exists` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Update a custom skill.
  app.put("/api/extensions/skills/:name", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const { name } = req.params;
    const { description, content, enabled } = req.body || {};
    // Locked bundled skills are immutable (D6) — the manifest lock wins over
    // any DB row sharing the name.
    const updatePolicy = bundle.skills.includes(name)
      ? ctx.splitPolicy(bundle.permissions[`skill:${name}`])
      : { locked: false };
    if (updatePolicy.locked) {
      return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be modified` });
    }
    const skill = extensionStore.getCustomSkill(name);
    if (!skill) {
      return res.status(404).json({ error: `Skill "${name}" not found` });
    }
    const updated = extensionStore.updateCustomSkill(name, { description, content, enabled });
    // Rewrite the materialized SKILL.md (atomic temp+rename) so the watcher
    // hot-reloads the new content; enabled=false removes the file instead.
    try { skillMaterialize.writeSkill(updated); } catch (e) { console.warn(`[skills] materialize rewrite failed for "${name}": ${e.message}`); }
    broadcast({ type: "extensions_changed", resource: "skill", action: "updated", name });
    res.json(updated);
  });

  // Remove a custom skill.
  app.delete("/api/extensions/skills/:name", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const { name } = req.params;
    // A name listed in the bundle manifest's skills is bundled; its lock policy
    // wins over any DB row with the same name (locked ⇒ immutable, D6).
    const deletePolicy = bundle.skills.includes(name)
      ? ctx.splitPolicy(bundle.permissions[`skill:${name}`])
      : { locked: false };
    if (deletePolicy.locked) {
      return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be removed` });
    }
    const skill = extensionStore.getCustomSkill(name);
    if (!skill) {
      return res.status(404).json({ error: `Skill "${name}" not found` });
    }
    extensionStore.removeCustomSkill(name);
    // Remove the materialized SKILL.md so the watcher hot-unloads it. The row
    // (not just the name) routes pack-owned skills out of their pack root.
    try { skillMaterialize.removeSkill(skill); } catch (e) { console.warn(`[skills] materialize remove failed for "${name}": ${e.message}`); }
    broadcast({ type: "extensions_changed", resource: "skill", action: "removed", name });
    res.json({ ok: true });
  });

  // Enable or disable a custom skill.
  app.patch("/api/extensions/skills/:name/enable", (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const { name } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Missing enabled (boolean)" });
    }
    // Locked bundled skills cannot be disabled (D6). Lock state comes from the
    // manifest, not the DB — file skills are never custom_skills rows.
    const togglePolicy = bundle.skills.includes(name)
      ? ctx.splitPolicy(bundle.permissions[`skill:${name}`])
      : { locked: false };
    if (togglePolicy.locked) {
      return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be disabled` });
    }
    const skill = extensionStore.getCustomSkill(name);
    if (!skill) {
      return res.status(404).json({ error: `Skill "${name}" not found` });
    }
    const updated = extensionStore.toggleCustomSkill(name, enabled);
    // enabled → write SKILL.md (hot-load); disabled → remove it (hot-unload,
    // from the row's root — pack-owned skills disable out of the pack root).
    try { enabled ? skillMaterialize.writeSkill(updated) : skillMaterialize.removeSkill(updated); }
    catch (e) { console.warn(`[skills] materialize toggle failed for "${name}": ${e.message}`); }
    broadcast({ type: "extensions_changed", resource: "skill", action: "toggled", name, enabled });
    res.json(updated);
  });

  // Get the market catalog (MCP servers + skills), filtered per user: bundled
  // entries are always visible; registry entries carrying groups require a
  // user-group intersection (extension-marketplace spec). req.user is null
  // when auth is off — the machine owner, who sees everything.
  app.get("/api/extensions/market", async (req, res) => {
    try {
      const catalog = await extensionStore.getMarketCatalog(req.user ?? null);
      res.json(catalog);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Install a registry-sourced skill: fetch its SKILL.md server-side with the
  // service token (never sent to the browser), then create it through the
  // normal custom-skill path (DB row + materialized SKILL.md hot-load).
  app.post("/api/extensions/market/skills/:name/install", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
    }
    const { name } = req.params;
    const entry = getMarketEntries().skills.find((s) => s.name === name);
    if (!entry) {
      return res.status(404).json({ error: `Registry skill "${name}" not found` });
    }
    // Admission mirrors the MCP market rule: a gated entry requires the
    // requester's groups to intersect. Auth off = machine owner ⇒ unrestricted.
    if (entry.groups?.length && ctx.authEnabled && !(req.user?.groups ?? []).some((g) => entry.groups.includes(g))) {
      return res.status(403).json({ error: `Skill "${name}" requires one of groups: ${entry.groups.join(", ")}` });
    }
    let raw;
    try {
      raw = await getSkillContent(entry.contentPath);
    } catch (err) {
      return res.status(502).json({ error: `Failed to fetch content for "${name}": ${err.message}` });
    }
    // The fetched SKILL.md carries its own frontmatter; the materializer
    // re-adds frontmatter from the DB row, so keep only the body.
    const content = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
    if (!content) {
      return res.status(502).json({ error: `Registry skill "${name}" has empty content` });
    }
    try {
      const skill = extensionStore.addCustomSkill({ name, description: entry.description, content, enabled: true });
      try { skillMaterialize.writeSkill(skill); } catch (e) { console.warn(`[skills] materialize write failed for "${name}": ${e.message}`); }
      broadcast({ type: "extensions_changed", resource: "skill", action: "added", name });
      res.json(skill);
    } catch (err) {
      if (err.message?.includes("UNIQUE constraint")) {
        return res.status(409).json({ error: `Skill "${name}" already exists` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ── External skill sources (read-only mirror, add-external-skill-sources) ──

  // Enabled sources + health, for the shelf's initial render (which tabs of
  // data to expect and how to caption them).
  app.get("/api/extensions/external/sources", (_req, res) => {
    res.json({ sources: externalSources.enabled });
  });

  // Aggregated search: fan out server-side (the browser never talks to the
  // external APIs — spec), top-N per source, grouped as returned. A failing
  // source yields its own failed/stale group; it never fails the response.
  app.get("/api/extensions/external/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    if (q.length > 200) return res.status(400).json({ error: "q too long" });
    try {
      const groups = await externalSources.searchAll(q, pageSize());
      res.json({ query: q, groups });
    } catch (err) {
      res.status(502).json({ error: `External source aggregation failed: ${err.message}` });
    }
  });

  // One entry's detail, resolved through the same snapshot cache. A disabled
  // or unknown source resolves to null → 404 (no data is invented).
  app.get("/api/extensions/external/entry/:source/:slug", async (req, res) => {
    const { source, slug } = req.params;
    if (!source || !slug || String(slug).length > 200) {
      return res.status(400).json({ error: "Bad source or slug" });
    }
    try {
      const out = await externalSources.getEntry(source, String(slug));
      if (!out) return res.status(404).json({ error: "Entry not found" });
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: `External source fetch failed: ${err.message}` });
    }
  });

  // ── External install (刀二) ────────────────────────────────────────────────
  // Preflight description of what installing the entry would produce: fetched
  // server-side, parsed, and returned — read-only, nothing stored. This is
  // the consent panel's data source.
  app.get("/api/extensions/external/install-preview/:source/:slug", async (req, res) => {
    const { source, slug } = req.params;
    if (!source || !slug || String(slug).length > 200) {
      return res.status(400).json({ error: "Bad source or slug" });
    }
    try {
      const preview = await previewInstall({ source: String(source), slug: String(slug), registry: externalSources });
      res.json({ preview });
    } catch (err) {
      res.status(externalErrorStatus(err)).json({ error: `Install preview failed: ${err.message}`, code: err.code ?? null });
    }
  });

  // The install itself. The consent gate is enforced HERE, not in the UI: a
  // request without `confirm: true` is refused before anything is fetched or
  // written, so an API caller cannot skip the informed-consent contract.
  app.post("/api/extensions/external/install", async (req, res) => {
    const { source, slug, confirm } = req.body || {};
    if (!source || !slug || String(slug).length > 200) {
      return res.status(400).json({ error: "Missing source or slug" });
    }
    if (confirm !== true) {
      return res.status(400).json({
        error: "Installation requires explicit confirmation (confirm: true) after reviewing the install preview",
        code: "confirm-required",
      });
    }
    try {
      const out = await performInstall({
        source: String(source),
        slug: String(slug),
        registry: externalSources,
        store: extensionStore,
        materialize: skillMaterialize,
        dbReady: () => db.isDbReady(),
      });
      broadcast({ type: "extensions_changed", resource: "skill", action: out.replaced ? "updated" : "added", name: out.skill.name });
      res.json({ skill: { name: out.skill.name, description: out.skill.description, originMeta: out.skill.originMeta }, replaced: out.replaced });
    } catch (err) {
      res.status(externalErrorStatus(err)).json({ error: `Install failed: ${err.message}`, code: err.code ?? null });
    }
  });
}
