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
import { buildBundle, bundleFileName, fromBase64, readBundle, toBase64, zipPluginPackage } from "../offline-bundle.js";
import { validatePackManifest } from "../../lib/pack-manifest.js";
import { checkCapabilityRefs, describeRefFailures } from "../../lib/check-capability-refs.js";
import { makeCatalogLoader } from "../../lib/capability-catalog-client.js";
import { packIdFromName } from "../../lib/pack-identity.js";
import {
  droppedSections,
  projectManifestToIR,
  toAgentPluginsPackage,
  validateProjectionBoundary,
} from "../pack-projection.js";
import { defaultBakedRoots, readBakedVersions } from "../../lib/pack-plugins.js";
import { installBudgetVerdict } from "../../lib/cell-mcp-budget.js";
import express from "express";

// Locale track (add-pack-locale-tracks B): installed-pack cards render under
// the SAME rules as the market — the zh base fields are the main track, a
// requested locale overlays the stored manifest's i18n block (lib/pack-locale
// owns the strategy). The stored row is never rewritten; only this response
// copy is projected, and a projected manifest is still a legal manifest (base
// strings + i18n block intact), so a client round-trip stays valid.
export function registerPackRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  // ── 装包闸：MCP server 上限（mcp-injection-budget-residual 2.2）──────────────
  //
  // 为什么有这条闸：2026-11-08，41 个包 → 32 个 MCP server → dsh 串行初始化
  // 撞破 60s → **整个 cell 起不来**、所有 fleet 的回合被跳过，而唯一的症状是
  // `initialize timed out`。所以装包面按「本次新增 + 当前在册」判，越线就拒。
  //
  // **必须在 `installPack` 之前判**：被拒的包因此一个字节都没落盘（验收口径就是
  // 「包未被物化」）。放在之后只能事后回滚，而回滚会留下 skills 根与 catalog 行。
  //
  // 数字与读面同源：`installBudgetVerdict` 里算的 count / 上限就是
  // `/api/ready` 的 `injectionSurface.budget`（同一份 `lib/cell-mcp-budget.js`），
  // 拒绝报文与读面各说一个数，运维就会按错的那个去卸包。
  //
  // 闸自己坏掉不拦装包（与购买闸的降级同向：市场不可达时如实降级为既往行为），
  // 但必须留痕——静默放行会让「上限」这件事再次变成没人知道的事实。
  const mcpBudgetRefusal = (manifest) => {
    let verdict;
    try {
      verdict = installBudgetVerdict({
        existingManifests: db.listInstalledPacks().map((p) => p.manifest),
        incomingManifest: manifest,
      });
    } catch (e) {
      console.warn(`[packs] mcp budget gate degraded (${e?.message || e}); install proceeds`);
      return null;
    }
    if (verdict.level === "soft") console.warn(`[packs] mcp budget: ${verdict.message}`);
    if (!verdict.refuse) return null;
    return {
      error: verdict.message,
      code: "mcp-budget-exceeded",
      details: {
        count: verdict.count,
        added: verdict.added,
        softLimit: verdict.softLimit,
        hardLimit: verdict.hardLimit,
      },
    };
  };

  // Assembly-time capability check (change: wire-capability-catalog-into-pack-assembly).
  // OFF by default: when CAPABILITY_CHECK_MODE is unset/off this returns null and
  // install is byte-for-byte unchanged. Two active modes:
  //   "warn"     — check runs, failures are logged, install proceeds (gray release)
  //   "enforce"  — failures refuse the install (409), same contract as budget gate
  // Resolves the governor's server_access when the caller supplies one; absent
  // means admin/full view (existence check only, no range narrowing) — the
  // docs' degraded-but-honest default.
  const capabilityCheckRefusal = async (manifest, governorServerAccess) => {
    const mode = (process.env.CAPABILITY_CHECK_MODE || "off").toLowerCase();
    if (mode !== "warn" && mode !== "enforce") return null;
    let result;
    try {
      const result2 = await checkCapabilityRefs(manifest, {
        pack: manifest?.name,
        failClosed: mode === "enforce",
        loadCatalog: makeCatalogLoader({ governorServerAccess }),
      });
      result = result2;
    } catch (e) {
      // The check itself faulted (not a catalog-unavailable verdict — that is
      // returned, not thrown). Never let a gate bug block install; leave a trace.
      console.warn(`[packs] capability check degraded (${e?.message || e}); install proceeds`);
      return null;
    }
    if (result.catalogUnavailable) {
      console.warn(`[packs] capability catalog unavailable (${result.reason || ""}); mode=${mode}`);
      if (result.ok) {
        // degrade mode: allowed but explicitly unverified — never silent
        console.warn("[packs] install proceeds WITHOUT capability verification");
      }
    }
    if (result.ok) return null;
    const detail = describeRefFailures(result);
    if (mode === "warn") {
      console.warn(`[packs] capability check (warn): ${detail}`);
      return null;
    }
    return {
      error: `Pack references capabilities you cannot use: ${detail}`,
      code: "capability-unavailable",
      details: {
        missing: result.missing,
        ungoverned: result.ungoverned,
        unavailable: result.unavailable,
      },
    };
  };


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

  // Per-persona MCP patches are composed from the installed pack set and then
  // cached per persona for the process lifetime (server.js composeMemberMcpPatch
  // → memberPatchCache). Installing, importing or removing a pack changes which
  // servers each persona's face declares, so the cache has to go with it —
  // otherwise a persona composed before this request keeps the old face until
  // the process restarts, with no error anywhere: the pack carries the tool,
  // the skill text asks for it, and the post simply never receives it. Live
  // 2026-11-14: v11 landed at 02:55Z while the composed faces on disk still
  // dated from 11-13, and only a restart made `fd-quant` reach chief/macro.
  const invalidateMemberFaces = () => {
    if (typeof ctx.invalidateMemberPatchCache !== "function") return;
    try {
      ctx.invalidateMemberPatchCache();
    } catch (e) {
      console.warn(`[packs] member patch cache invalidation failed: ${e?.message || e}`);
    }
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
        packIdFromName(manifest.name);
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
      // Second target (add-pack-raven-export): the same validated manifest can
      // leave as an Agent Plugins 1.0 directory instead of a `.yizpack`. Both
      // targets run the identical validator above - exporting must never be
      // more permissive than installing.
      // Second target (add-pack-raven-export): the same snapshot can leave as an
      // Agent Plugins 1.0 directory instead of a `.yizpack`. It goes through the
      // same boundary + IR the other three envelopes use - an export that read the
      // raw manifest would be a fourth answer to "what may leave".
      const target = typeof req.body?.target === "string" ? req.body.target : "yizpack";
      if (target === "plugin-package" || target === "agent-plugins") {
        const boundary = validateProjectionBoundary(manifest);
        if (boundary.length > 0) {
          return res.status(400).json({ error: "Manifest is outside the outbound boundary", details: boundary });
        }
        let built;
        try {
          built = toAgentPluginsPackage(projectManifestToIR(manifest), {
            dropped: droppedSections(manifest),
            // The same durable id the zip is named after: the package's INSIDE
            // identity must match its file name, or the artifact contradicts
            // itself (exported as `wire-assistant-3.plugin.zip` with
            // `plugin.json name: "pack"`).
            packId,
          });
        } catch (err) {
          return res.status(400).json({ error: err.message, code: err.code });
        }
        const bytes = await zipPluginPackage(built.files, { packId, version });
        return res.json({
          bundle: toBase64(bytes),
          fileName: `${packId}-${version}.plugin.zip`,
          meta: {
            packId,
            version,
            target: "plugin-package",
            files: Object.keys(built.files).length,
            notProjected: built.notProjected.map((entry) => entry.field),
          },
        });
      }
      if (target !== "yizpack") {
        return res.status(400).json({
          error: `unknown export target '${target}' (expected 'yizpack' or 'plugin-package')`,
        });
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
        meta: { packId, version, target: "yizpack" },
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
          // 三支柱与编制（openspec: pillar-surfaces / team-derivation）。与上游
          // `compileDraftManifest` 成对：那边带出去、这边读回来，缺一半就是
          // 「存一次丢一段、导入一次丢另一段」。同样是 abs-ent ⇒ 老包的草稿逐字节不变。
          ...(manifest.memory ? { memory: manifest.memory } : {}),
          ...(manifest.console ? { console: manifest.console } : {}),
          ...(manifest.fleet ? { fleet: manifest.fleet } : {}),
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
      const refusal = mcpBudgetRefusal(manifest);
      if (refusal) return res.status(409).json(refusal);
      // Assembly-time capability check (off by default). Governor range needs
      // the assembler's server_access, which paas does NOT currently produce
      // (`req.user` carries email+groups+roles only — verified in server/auth.js).
      // So today this runs the existence check only (governor = null = full
      // visibility). Range narrowing requires paas to inject server_access
      // (resolve groups→scopes via registry) — a follow-up, not faked here.
      const capRefusal = await capabilityCheckRefusal(manifest, null);
      if (capRefusal) return res.status(409).json(capRefusal);
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
      invalidateMemberFaces();
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

        const refusal = mcpBudgetRefusal(manifest);
        if (refusal) return res.status(409).json(refusal);
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
        invalidateMemberFaces();
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
      invalidateMemberFaces();
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
