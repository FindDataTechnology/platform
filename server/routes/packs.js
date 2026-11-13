// Pack marketplace cell-side API (add-pack-marketplace).
//
// Creator drafts (private to this cell), and the subscribe/upgrade/uninstall
// actions whose materialization lives in pack-store.js. All routes sit behind
// the deployment-shaped MCP manage gate — installing a pack writes MCP
// configurations, so it carries exactly the same authority as adding an MCP
// server by hand. The marketplace itself (browse/publish/subscribe records)
// is gateway- or facet-side; installs resolve the manifest server-side
// (pack-install-server-side-manifest) so the browser never carries manifest
// bodies through the edge.

import * as packStore from "../../pack-store.js";
import { revokeDeploymentBindingsForPack } from "../../deployment-bindings.js";
import { fetchMarketManifest, fetchMarketDetail } from "../pack-manifest-source.js";
import { projectPackList } from "../../lib/pack-locale.js";
import { buildBundle, bundleFileName, fromBase64, readBundle, toBase64 } from "../offline-bundle.js";
import { validatePackManifest } from "../../lib/pack-manifest.js";
import { defaultBakedRoots, readBakedVersions } from "../../lib/pack-plugins.js";
import express from "express";

// Locale track (add-pack-locale-tracks B): installed-pack cards render under
// the SAME rules as the market — the zh base fields are the main track, a
// requested locale overlays the stored manifest's i18n block (lib/pack-locale
// owns the strategy). The stored row is never rewritten; only this response
// copy is projected, and a projected manifest is still a legal manifest (base
// strings + i18n block intact), so a client round-trip stays valid.
export function registerPackRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  // Team plugin supply proof (add-fleet-plugin-declaration 1.2): the roster is
  // the runtime's own answer to "what is baked here", and the versions come from
  // the installed tree. Read per install — no caching, so a re-bake is visible
  // immediately. A runtime that cannot answer yields no roster, and installPack
  // refuses rather than assuming.
  const resolvePluginSupply = async ({ declared = [] } = {}) => {
    const inventory = await ctx.getPluginBundles?.();
    const roster = Array.isArray(inventory?.bundles) ? inventory.bundles : null;
    const ids = declared.map((p) => p?.id).filter(Boolean);
    const bakedVersions = ids.length > 0 ? readBakedVersions({ roots: defaultBakedRoots(), ids }) : new Map();
    return { roster, bakedVersions };
  };

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

  // ── Draft export/import (add-offline-pack-authoring) ─────────────────────
  //
  // The AUTHORING half of the offline loop: a draft is cell-local, and its
  // only exit used to be the online gateway publish. Now a draft can be
  // compiled by the editor into a manifest, validated server-side by the SAME
  // rules an install applies, and packed into a `.yizpack` — deliverable to
  // any machine with no network. And a bundle can come back as a NEW editable
  // draft (round-trip), without installing anything.
  //
  // Semantics red line: EXPORT IS NOT PUBLISH. No packId minting, no version
  // freeze, no creator gate, no skill/MCP/agent materialization, and the
  // draft stays editable throughout.

  app.post("/api/pack-drafts/:id/export-bundle", async (req, res) => {
    if (!requireGate(req, res)) return;
    try {
      const draft = packStore.getDraft(req.params.id);
      const manifest = req.body?.manifest;
      if (!manifest?.name) {
        return res.status(400).json({ error: "manifest with a name is required" });
      }
      // Same validator the install path applies — offline authoring is never
      // exempt from the pack rules.
      const errors = validatePackManifest(manifest);
      if (errors.length > 0) {
        return res.status(400).json({ error: "Invalid manifest", details: errors });
      }
      // Identity for the artifact: an already-published draft keeps its pack
      // id (the bundle then installs as an upgrade on other machines); a
      // never-published draft derives one from the manifest name.
      const packId =
        (typeof req.body?.packId === "string" && req.body.packId) ||
        draft.publishedPackId ||
        String(manifest.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
        "draft-pack";
      // Version semantics (precedence): an explicit request wins; then — for
      // a draft that has already been published — the version this machine has
      // INSTALLED for that pack (the durable snapshot), so the bundle installs
      // as an upgrade elsewhere rather than a silent downgrade to 1; then the
      // manifest's own version; then 1 for a never-published draft.
      const installedRow = draft.publishedPackId ? db.getInstalledPack(packId) : null;
      const version = Number(
        req.body?.version ?? installedRow?.version ?? manifest.version ?? 1,
      );
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: "version must be a positive integer" });
      }
      const bytes = await buildBundle({
        packId,
        version,
        manifest,
        origin: `draft export (${draft.name})`,
      });
      return res.json({
        bundle: toBase64(bytes),
        fileName: bundleFileName(packId, version),
        meta: { packId, version },
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post(
    "/api/pack-drafts/import-bundle",
    express.raw({ type: ["application/octet-stream", "application/zip"], limit: "64mb" }),
    async (req, res) => {
      if (!requireGate(req, res)) return;
      try {
        const bytes = Buffer.isBuffer(req.body) && req.body.length > 0
          ? req.body
          : fromBase64(req.body?.bundle ?? req.body?.bundleBase64);
        const { meta, manifest } = await readBundle(bytes);
        if (!manifest?.name) {
          return res.status(400).json({ error: "bundle manifest carries no name", code: "bundle_manifest_invalid" });
        }
        // Reverse-compile: manifest → editable draft entries. IMPORT IS
        // EDITING, NOT INSTALLING — nothing is materialized (no skills, no
        // MCP, no agents rows, no installed_packs). bots ride the entries so
        // a round-trip loses nothing the editor can carry.
        const entries = {
          skills: manifest.skills ?? [],
          mcpServers: manifest.mcpServers ?? [],
          agents: manifest.agents ?? [],
          ...(manifest.bots ? { bots: manifest.bots } : {}),
          ...(manifest.guide ? { guide: manifest.guide } : {}),
          // Adopted provenance (add-official-adopted-agents 1.4): an imported
          // bundle round-trips its audit trail too — dropping it here would let
          // an adopted pack be re-published with attribution silently gone.
          // Absent on ordinary packs, so their drafts stay byte-identical.
          ...(manifest.provenance ? { provenance: manifest.provenance } : {}),
        };
        const draft = packStore.createDraft({
          name: String(manifest.name),
          description: manifest.description ?? "",
          tags: Array.isArray(manifest.tags) ? manifest.tags : [],
          entries,
        });
        return res.json({
          draft,
          bundle: { packId: meta.packId, version: meta.version, origin: meta.origin ?? null },
        });
      } catch (err) {
        return res.status(err.status || 500).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.path ? { path: err.path } : {}),
        });
      }
    },
  );

  // ── Installed packs ────────────────────────────────────────────────────────

  app.get("/api/mypacks", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({
      packs: projectPackList(db.listInstalledPacks(), {
        locale: req.query.locale,
        acceptLanguage: req.headers["accept-language"],
      }),
    }));
  });

  // Materialize a pack version snapshot. Two accepted request shapes
  // (pack-install-server-side-manifest):
  //   - {packId, version} — the manifest is retrieved HERE, server-side, over
  //     the market channel (the same facet request/identity construction as
  //     the /api/packs proxy). This is what the web client sends: manifest
  //     bodies legally embed code/SQL in SKILL.md and the deployment edge WAF
  //     resets such browser POSTs.
  //   - {packId, version, manifest} — rolling-window compatibility; processed
  //     through the identical validation pipeline (one installPack call, one
  //     set of rules). A body manifest wins when both are present.
  // Retrieval failure is terminal: clear error, nothing written.
  app.post("/api/mypacks/install", async (req, res) => {
    if (!requireGate(req, res)) return;
    const { packId, version, manifest: bodyManifest } = req.body || {};
    let manifest = bodyManifest;
    // 装前闸（add-market-revenue-share）：市场面证词说「付费且未成交」的
    // 条目不得物化——闸与详情/购买状态同源（fetchMarketDetail）；价格为空
    // = 免费条目不拦；市场暂不可达时如实降级为既往行为（详情/购买两道
    // 写面在同台市场，不可用者自见，不虚构成交）。
    if (packId) {
      const viewer = req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] });
      try {
        const detail = await fetchMarketDetail({ packId, viewer, localMarket: ctx.localPackMarket ?? null });
        if (detail?.pricing && !detail.purchased) {
          return res.status(402).json({
            error: "This pack is not in your purchases — buy it on the market first",
            code: "market-purchase-required",
          });
        }
      } catch (e) {
        if (e?.status === 404) {
          if (!bodyManifest) return res.status(404).json({ error: "Pack version not found" });
          // body-manifest rolling compat: market says the id does not exist —
          // the legacy manifest-in-body path unchanged (visibility is the
          // market's call at read time, install validation owns the rest).
        } else {
          console.warn(`[packs] install purchase gate degraded (${e?.message || e}); proceeding with legacy flow`);
        }
      }
    }
    try {
      if (!manifest) {
        if (!packId || version === undefined || version === null || !Number.isInteger(Number(version))) {
          return res.status(400).json({ error: "packId and version are required" });
        }
        manifest = await fetchMarketManifest({
          packId,
          version,
          // The caller's identity rides the retrieval: private-pack visibility
          // is evaluated for THIS user, exactly as the market listing does.
          // Auth off (dev/e2e machine owner) resolves to the same fallback
          // identity the in-process market mount uses.
          viewer: req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] }),
          localMarket: ctx.localPackMarket ?? null,
        });
      }
      const { report, installed } = await packStore.installPack({
        packId,
        version,
        manifest,
        user: req.user,
        // add-packaged-skills D5: script-bearing packs need the explicit
        // acknowledgment; the error carries code "script-confirm-required"
        // which the client maps to the one-time confirm dialog.
        confirm: req.body?.confirm === true,
        pluginSupply: resolvePluginSupply,
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
        ...(err.code ? { code: err.code } : {}),
        ...(err.details ? { details: err.details } : {}),
      });
    }
  });

  app.get("/api/mypacks/:packId/uninstall-preview", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => packStore.uninstallPreview(req.params.packId));
  });

  // ── Offline bundle import (add-offline-pack-supply) ─────────────────────
  //
  // The AIRGAPPED supply shape: the client hands us a `.yizpack` (raw
  // octet-stream, or base64 inside JSON — the global parser owns /api/mypacks
  // JSON bodies). After the bundle's own integrity gates, the manifest takes
  // the IDENTICAL installPack pipeline as a market install: offline never
  // means unchecked, and the purchase gate keeps its existing semantics (a
  // reachable market still refuses an unpurchased paid pack; an unreachable
  // one degrades exactly like the body-manifest compatibility path).
  app.post(
    "/api/mypacks/import-bundle",
    express.raw({ type: ["application/octet-stream", "application/zip"], limit: "64mb" }),
    async (req, res) => {
      if (!requireGate(req, res)) return;
      try {
        const bytes = Buffer.isBuffer(req.body) && req.body.length > 0
          ? req.body
          : fromBase64(req.body?.bundle ?? req.body?.bundleBase64);
        const { meta, manifest } = await readBundle(bytes);
        const packId = String(req.body?.packId || meta.packId);
        const version = Number(req.body?.version ?? meta.version);
        if (packId !== meta.packId || version !== meta.version) {
          return res.status(400).json({
            error: "bundle does not match the requested packId/version",
            code: "bundle_target_mismatch",
            bundle: { packId: meta.packId, version: meta.version },
            requested: { packId, version },
          });
        }

        // Purchase-gate parity with /api/mypacks/install: same query, same
        // 402, same degrade when the market cannot answer.
        const viewer = req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] });
        try {
          const detail = await fetchMarketDetail({ packId, viewer, localMarket: ctx.localPackMarket ?? null });
          if (detail?.pricing && !detail.purchased) {
            return res.status(402).json({
              error: "This pack is not in your purchases — buy it on the market first",
              code: "market-purchase-required",
            });
          }
        } catch (e) {
          if (e?.status === 404) {
            // Market reachable and says the id does not exist: the bundle may
            // still install (it carries its own manifest) — same rolling
            // compatibility the body-manifest shape has always had.
          } else {
            console.warn(`[packs] import purchase gate degraded (${e?.message || e}); proceeding offline`);
          }
        }

        const { report, installed } = await packStore.installPack({
          packId,
          version,
          manifest,
          user: req.user,
          confirm: req.body?.confirm === true || meta?.confirm === true,
          source: "bundle",
          pluginSupply: resolvePluginSupply,
          hooks: {
            onMcpChanged: () => {
              broadcast({ type: "extensions_changed", resource: "mcp", action: "pack-import", name: manifest?.name || packId });
              ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined)
                .catch((e) => console.warn(`[packs] dsh MCP update failed: ${e.message}`));
            },
            onCatalogChanged: () => {
              broadcast({ type: "catalog_changed" });
              void ctx.syncCatalogAgentPresets?.();
            },
          },
        });
        await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[packs] skills patch update failed: ${e.message}`));
        return res.json({ report, installed, bundle: { packId: meta.packId, version: meta.version, origin: meta.origin ?? null } });
      } catch (err) {
        return res.status(err.status || 500).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details ? { details: err.details } : {}),
          ...(err.path ? { path: err.path } : {}),
        });
      }
    },
  );

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
      // Deployment-scoped connector bindings (add-deployment-binding-grant
      // 2.3): uninstall is not undeploy — a pack can be gone from this cell
      // while agents it published keep serving elsewhere, and revoking their
      // credentials here would be a silent outage. The tokens die only once
      // this cell holds no deployment of the pack.
      let deploymentCleanup = null;
      const registry = ctx.getPackRegistry?.() ?? null;
      if (registry?.deployments?.(req.params.packId).length === 0) {
        deploymentCleanup = await revokeDeploymentBindingsForPack({
          email: req.user?.email ?? ctx.cellUserEmail ?? "owner@local",
          packId: req.params.packId,
          secrets: registry.deploymentSecretsForPack(req.params.packId),
          remove: (agentId, name) => registry.deleteDeploymentSecret(req.params.packId, agentId, name),
        }).catch((e) => ({ revoked: [], failed: [], code: e?.message || "unavailable" }));
      }
      res.json({ ...result, ...(deploymentCleanup ? { deploymentCleanup } : {}) });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.modifiedSkills ? { modifiedSkills: err.modifiedSkills } : {}),
      });
    }
  });
}
