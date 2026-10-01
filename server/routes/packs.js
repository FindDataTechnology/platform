// Pack marketplace cell-side API (add-pack-marketplace).
//
// Creator drafts (private to this cell), and the subscribe/upgrade/uninstall
// actions whose materialization lives in pack-store.js. All routes sit behind
// the deployment-shaped MCP manage gate — installing a pack writes MCP
// configurations, so it carries exactly the same authority as adding an MCP
// server by hand. The marketplace itself (browse/publish/subscribe records)
// is gateway-side; the browser fetches a manifest there and posts it here.

import * as packStore from "../../pack-store.js";

export function registerPackRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  const dbGate = (_req, res) => {
    if (!db.isDbReady()) {
      res.status(503).json({ error: "Packs are disabled (database unavailable)" });
      return false;
    }
    return true;
  };
  const requireGate = (req, res) => {
    if (!dbGate(req, res)) return false;
    if (!ctx.requireMcpManage(req, res)) return false;
    return true;
  };

  const respond = (res, fn) => {
    try {
      const result = fn();
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
        ...(err.modifiedSkills ? { modifiedSkills: err.modifiedSkills } : {}),
      });
    }
  };

  // ── Drafts ────────────────────────────────────────────────────────────────

  app.get("/api/pack-drafts", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ drafts: packStore.listDrafts() }));
  });

  app.post("/api/pack-drafts", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ draft: packStore.createDraft(req.body || {}) }));
  });

  app.get("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ draft: packStore.getDraft(req.params.id) }));
  });

  app.put("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    const { name, description, tags, entries } = req.body || {};
    respond(res, () => ({ draft: packStore.updateDraft(req.params.id, { name, description, tags, entries }) }));
  });

  app.delete("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => packStore.deleteDraft(req.params.id));
  });

  // Note a draft's first published pack id, so the editor's next publish
  // targets the same pack (version append) instead of minting a new one.
  app.post("/api/pack-drafts/:id/published", (req, res) => {
    if (!requireGate(req, res)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId required" });
    respond(res, () => ({ draft: db.setDraftPublishedPack(req.params.id, packId) }));
  });

  // ── Installed packs ────────────────────────────────────────────────────────

  app.get("/api/mypacks", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ packs: db.listInstalledPacks() }));
  });

  // Materialize a pack version snapshot. The manifest arrives from the
  // browser (fetched from the gateway with the user's session — design D8)
  // and is re-validated here before anything is written.
  app.post("/api/mypacks/install", async (req, res) => {
    if (!requireGate(req, res)) return;
    const { packId, version, manifest } = req.body || {};
    try {
      const { report, installed } = await packStore.installPack({
        packId,
        version,
        manifest,
        user: req.user,
        hooks: {
          onMcpChanged: () => {
            broadcast({ type: "extensions_changed", resource: "mcp", action: "pack-install", name: manifest?.name || packId });
            ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined)
              .catch((e) => console.warn(`[packs] dsh MCP update failed: ${e.message}`));
          },
          onCatalogChanged: () => {
            broadcast({ type: "catalog_changed" });
            void ctx.syncCatalogAgentPresets?.();
          },
        },
      });
      // The pack's skills materialized under a per-pack root the skills patch
      // must list (full mode) — rewrite it; an idle runtime restarts so the
      // watched-dir set takes effect (add-pack-agent-scoping).
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[packs] skills patch update failed: ${e.message}`));
      res.json({ report, installed });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
  });

  app.get("/api/mypacks/:packId/uninstall-preview", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => packStore.uninstallPreview(req.params.packId));
  });

  // Uninstall removes pack-owned skills and agent entries. A modified pack
  // skill forces an explicit ?force=1 (the server-side half of the warning
  // gate); MCP configurations are always kept.
  app.delete("/api/mypacks/:packId", async (req, res) => {
    if (!requireGate(req, res)) return;
    const force = req.query.force === "1" || req.query.force === "true";
    try {
      const result = packStore.uninstallPack({
        packId: req.params.packId,
        force,
        hooks: {
          onCatalogChanged: () => {
            broadcast({ type: "catalog_changed" });
            void ctx.syncCatalogAgentPresets?.();
          },
        },
      });
      // The pack root is gone: rewrite the skills patch so it stops listing
      // the dead root (full mode) — same rewrite/restart contract as install.
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[packs] skills patch update failed: ${e.message}`));
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.modifiedSkills ? { modifiedSkills: err.modifiedSkills } : {}),
      });
    }
  });
}
