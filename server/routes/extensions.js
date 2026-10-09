// Extensions management API (MCP servers + custom skills).

import { getFileSkills } from "../skills.js";
import { getMarketEntries, getSkillContent } from "../../registry-bridge.js";
import * as registryCredentials from "../../registry-credentials.js";

export function registerExtensionRoutes(ctx) {
  const { app, db, extensionStore, skillMaterialize, broadcast } = ctx;
  const bundle = ctx.bundle;

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
    // Registry-origin installs are credential-shaped (registry-sso-credentials):
    // the record references the installer's stored market credential, and the
    // Authorization header is resolved at profile-write time. Installing
    // without a live credential is refused — storing the template's
    // placeholder would create a server that can never authenticate — so the UI
    // routes the user to connect (or paste a token) and retries.
    let config = submitted;
    if (entry?.origin === "registry") {
      const status = registryCredentials.status(req.user?.email ?? null);
      if (!status.connected) {
        return res.status(409).json({
          error: "Connect the MCP market (or paste a token) before installing registry servers",
          code: "credential-required",
        });
      }
      const { headers: _placeholderHeaders, ...rest } = submitted;
      config = { ...rest, credentialRef: registryCredentials.REGISTRY_CREDENTIAL_REF };
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
        }))
      : [];
    res.json({ skills: [...fileSkills, ...customSkills] });
  });

  // Add a new custom skill.
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
}
