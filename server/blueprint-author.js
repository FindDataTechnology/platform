// Blueprint author bridge (add-builder-team-templates) — the blueprint
// constructor's loopback lane, cloned from the fleet-architect pattern
// (server/fleet-architect.js): loopback is its credential, the ROUTES resolve
// the acting owner from ctx.cellUserEmail server-side, and every write is the
// EXISTING blueprint chain — validateBlueprint for the verdict, store
// .createBlueprint for the pool. No approve, no cast, no trial, no delete:
// those are the owner's gestures in the Blueprint Studio (fleet-blueprint-
// studio 既有纪律原样覆盖工具面来稿).
//
// Three-piece separation: drafts_list (read the pool) → validate (dry-run,
// nothing persisted) → save (validation-green only, lands in the SAME draft
// pool the paste channel writes).

import { Router } from "express";
import { getBlueprintDatabase } from "./routes/blueprints-db.js";
import { validateBlueprint, dataSourceFindings } from "./blueprint-validate.js";
import { isDbReady, getCollection } from "../db.js";

export function registerBlueprintAuthorRoutes(app, ctx = null) {
  const router = Router();
  const owner = () => ctx?.cellUserEmail || "owner@local";
  const store = () => getBlueprintDatabase();
  // Library refs (`library:<collectionId>`) resolve against this deployment's
  // collections (add-knowledge-memory-surface 3.1): a dangling or invisible id
  // is refused by name at validation time. No DB → skip (a storage problem must
  // not block every blueprint), matching the judge-roster posture.
  const resolveLibrary = (id) => {
    if (!isDbReady()) return true;
    return getCollection(id) ? true : "no such collection in this deployment";
  };

  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[blueprint-author-access] ${req.method} ${req.baseUrl}${req.path} ${owner()}`);
    }
    next();
  });

  // Read the owner's draft pool — the same list the Blueprint Studio renders.
  router.get("/drafts", (_req, res) => {
    try {
      res.json({ drafts: store().listBlueprints(owner()) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dry-run: the full existing verdict, nothing persisted. Unknown shape →
  // the validator's own errors (no second validator lives here).
  router.post("/validate", (req, res) => {
    try {
      const verdict = validateBlueprint(req.body?.content, { resolveLibrary });
      res.json({ ok: verdict.ok, errors: verdict.errors, findings: verdict.findings, manifestPreview: verdict.manifestPreview });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Save into the draft pool — validation-green only. A red draft refuses to
  // land (spec: 未过校验的草稿 SHALL 拒绝落池并指名错误); shape findings ride
  // as warnings exactly like the paste channel (草稿可以是 WIP).
  router.post("/save", (req, res) => {
    try {
      const content = req.body?.content;
      const verdict = validateBlueprint(content, { resolveLibrary });
      if (!verdict.ok) {
        return res.status(422).json({ ok: false, error: "validation must be green before saving", errors: verdict.errors, findings: verdict.findings });
      }
      const sceneName = String(req.body?.name ?? content?.boundary?.name ?? content?.fleet?.name ?? "").trim();
      if (!sceneName) {
        return res.status(400).json({ error: "blueprint needs a scene name (name, boundary.name, or fleet.name)" });
      }
      const created = store().createBlueprint({
        id: `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ownerEmail: owner(),
        name: sceneName,
        oneLine: req.body?.oneLine ?? content?.boundary?.oneLine ?? "",
        outOfScope: req.body?.outOfScope ?? content?.boundary?.outOfScope ?? "",
        content,
      });
      res.status(201).json({ ok: true, blueprint: created, warnings: dataSourceFindings(content) });
    } catch (err) {
      if (err?.status === 422) return res.status(422).json({ ok: false, error: err.message, findings: err.findings });
      res.status(500).json({ error: err.message });
    }
  });

  app.use("/api/blueprint-author", router);
}
