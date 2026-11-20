// Pack author bridge (add-builder-team-templates) — the pack author's
// loopback lane, cloned from the fleet-architect pattern. The author agent
// composes a manifest, this lane validates it through the SAME
// validatePackManifest an install applies, and lands it as an EDITABLE DRAFT
// (the manifest projected onto the draft entries shape the editor consumes).
// No publish, no pricing, no deploy, no packId minting: those are the owner's
// gestures through the existing publish gate (export is not publish either —
// add-offline-pack-authoring's red line applies verbatim to tool-face saves).
//
// MCP references are PICKED, never typed: the market-servers read exposes the
// same registry-sourced catalog the editor's picker uses, so a free-form
// endpoint/command cannot enter through the tool face (v1 content boundary).

import { Router } from "express";
import * as packStore from "../pack-store.js";
import { validatePackManifest } from "../lib/pack-manifest.js";

// manifest → draft entries projection: the editor's shape, field-for-field.
// The manifest stays the compositional truth (the author wrote it); the draft
// is its editable projection.
function manifestToDraftFields(manifest) {
  return {
    name: String(manifest.name ?? "").trim(),
    description: typeof manifest.description === "string" ? manifest.description : "",
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    entries: {
      skills: Array.isArray(manifest.skills) ? manifest.skills : [],
      mcpServers: Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [],
      agents: Array.isArray(manifest.agents) ? manifest.agents : [],
      ...(manifest.guide && typeof manifest.guide === "object" ? { guide: manifest.guide } : {}),
    },
  };
}

export function registerPackAuthorRoutes(app, ctx = null) {
  const router = Router();
  const owner = () => ctx?.cellUserEmail || "owner@local";

  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[pack-author-access] ${req.method} ${req.baseUrl}${req.path} ${owner()}`);
    }
    next();
  });

  // The owner's draft pool (the editor's list, read-only here).
  router.get("/drafts", (_req, res) => {
    try {
      res.json({
        drafts: packStore.listDrafts().map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          publishedPackId: d.publishedPackId ?? null,
          counts: {
            skills: d.entries?.skills?.length ?? 0,
            mcp: d.entries?.mcpServers?.length ?? 0,
            agents: d.entries?.agents?.length ?? 0,
          },
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The registry-sourced MCP catalog (viewer-aware, same source the editor's
  // picker consumes — extensionStore rides the cell ctx like extensions.js).
  // An absent store (bare test mount) answers an honest empty list.
  router.get("/market-servers", async (_req, res) => {
    try {
      const store = ctx?.extensionStore ?? null;
      if (!store?.getMarketCatalog) return res.json({ servers: [] });
      const catalog = await store.getMarketCatalog(null);
      const servers = (catalog?.mcpServers ?? [])
        .filter((s) => s.origin === "registry" || s.origin === "bundled")
        .map((s) => ({ name: s.name, description: s.description ?? "", origin: s.origin }));
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dry-run: the same validator the install path applies, per-item errors.
  router.post("/validate", (req, res) => {
    try {
      const errors = validatePackManifest(req.body?.manifest);
      res.json({ ok: errors.length === 0, errors });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Save as an EDITABLE draft — validation-green only. An existing draft id
  // (or publishedPackId match) updates; otherwise a new draft is created.
  // EXPORT/SAVE IS NOT PUBLISH: no packId minting, no version freeze, no gate.
  router.post("/save", (req, res) => {
    try {
      const manifest = req.body?.manifest;
      if (!manifest || typeof manifest !== "object" || !String(manifest.name ?? "").trim()) {
        return res.status(400).json({ error: "manifest with a name is required" });
      }
      const errors = validatePackManifest(manifest);
      if (errors.length > 0) {
        return res.status(422).json({ ok: false, error: "validation must be green before saving", errors });
      }
      const fields = manifestToDraftFields(manifest);
      const existingId = typeof req.body?.draftId === "string" ? req.body.draftId : null;
      const draft = existingId
        ? packStore.updateDraft(existingId, fields)
        : packStore.createDraft(fields);
      res.status(existingId ? 200 : 201).json({
        ok: true,
        draft: { id: draft.id, name: draft.name },
        note: "Saving is NOT publishing — publish happens through the pack editor's publish gate, not here.",
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.use("/api/pack-author", router);
}
