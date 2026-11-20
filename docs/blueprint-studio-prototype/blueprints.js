// [PROTOTYPE · 非权威] fleet-blueprint-studio Slice 1
// apply 时落点：server/routes/blueprints.js；并在 server.js 的
// `createFleetRoutes(app, ctx)` 之后挂载：
//   app.use(createBlueprintRoutes(ctx));
//
// Blueprint studio REST face: CRUD → validate → approve → cast → trial-report.
// Approval discipline mirrors agent-fleet-architect (design D4): nothing is
// cast to the market (or touched in fleet state) unless the owner explicitly
// approved, and cast revalidation re-runs the full chain against THE SAME
// approved draft (edit after approval → 409, never silent proceed).

import { Router } from "express";
import {
  createBlueprintDatabase,
  listBlueprints,
  getBlueprint,
  createBlueprint,
  updateBlueprint,
  recordApproval,
  recordCast,
  saveTrialReport,
  rowToBlueprint,
  rowToListEntry,
} from "./blueprints-db.js";
import {
  blueprintShapeErrors,
  runBlueprintValidation,
  diffBlueprint,
} from "./blueprint-validate.js";

function resolveUserFactory(ctx) {
  return (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
}

export function createBlueprintRoutes(ctx = {}) {
  const app = Router();
  const resolveUser = ctx.resolveUser ?? resolveUserFactory(ctx);
  // Factory-injected DB (requester calibration): production default file when
  // no instance passed; unit tests pass their own tmp-file instance.
  const db = ctx.blueprintDb ?? createBlueprintDatabase({});
  // Publish client inversion: unit runs never touch the real marketplace door.
  const publishClient = ctx.publishClient ?? defaultPublishClient();

  // ── list / read ─────────────────────────────────────────────────────
  app.get("/api/blueprints", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    res.json({ blueprints: listBlueprints(db, user.email).map(rowToListEntry) });
  });

  app.get("/api/blueprints/:id", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    res.json(rowToBlueprint(bp));
  });

  // ── create / edit ───────────────────────────────────────────────────
  app.post("/api/blueprints", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const body = req.body ?? {};
    const content = body.content ?? body;
    const shape = blueprintShapeErrors(content);
    const boundary = content?.boundary ?? {};
    const bp = createBlueprint(db, {
      ownerEmail: user.email,
      name: body.name ?? boundary.name ?? "",
      oneLine: body.oneLine ?? boundary.oneLine ?? "",
      outOfScope: boundary.outOfScope ?? "",
      contentJson: JSON.stringify(content),
    });
    res.status(201).json({ ...rowToBlueprint(bp), shapeErrors: shape });
  });

  // Edit creates a NEW DRAFT VERSION (optimistic concurrency: the caller
  // must name the version the edit is based on — drift → 409).
  app.put("/api/blueprints/:id", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    const posted = req.body ?? {};
    const expected = Number(posted.expectVersion ?? posted.version);
    if (!Number.isInteger(expected) || expected < 1) {
      return res.status(400).json({ error: "expectVersion is required (the version this edit is based on)" });
    }
    const nextContent = posted.content;
    if (!nextContent || typeof nextContent !== "object") {
      return res.status(400).json({ error: "content must be the new blueprint object" });
    }
    const prevContent = JSON.parse(bp.content_json);
    const diff = diffBlueprint(prevContent, nextContent);
    if (!updateBlueprint(db, bp.id, { contentJson: JSON.stringify(nextContent), diffSummary: JSON.stringify(diff) }, expected)) {
      return res.status(409).json({ error: "conflict: blueprint was edited concurrently", nowVersion: getBlueprint(db, bp.id).version });
    }
    const fresh = getBlueprint(db, bp.id);
    res.json({ ...rowToBlueprint(fresh), diff });
  });

  // ── validate (full chain → manifest preview + errors) ───────────────
  app.post("/api/blueprints/:id/validate", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    const result = runBlueprintValidation(JSON.parse(bp.content_json));
    res.json({
      ok: result.ok,
      stage: result.stage ?? null,
      errors: result.errors,
      manifestPreview: result.manifest ?? null,
      version: bp.version,
    });
  });

  // ── approve (fresh full-green validation on the same version) ───────
  app.post("/api/blueprints/:id/approve", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    const posted = req.body ?? {};
    const expectVersion = Number(posted.expectVersion ?? posted.version);
    if (expectVersion !== bp.version) {
      return res.status(409).json({ error: "conflict: approve must target the same draft version that was validated", nowVersion: bp.version });
    }
    const result = runBlueprintValidation(JSON.parse(bp.content_json));
    if (!result.ok) {
      return res.status(422).json({ error: "approval refused: validation is not green", stage: result.stage ?? null, errors: result.errors });
    }
    recordApproval(db, bp.id, {
      approvedBy: user.email,
      approvedAt: new Date().toISOString(),
      diffSummary: bp.diff_summary ?? "[]",
    });
    res.json({ ok: true, status: "approved", approvedBy: user.email, approvedAt: new Date().toISOString(), version: bp.version });
  });

  // ── cast (two-stage discipline: same-draft approval → revalidate) ───
  app.post("/api/blueprints/:id/cast", async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });

    // Stage 1 · approval must exist and target the current draft version —
    // edits after approval silently rewrote version? No: edits clear approval
    // in the store, so a stale-approved state is structurally unreachable;
    // this gate still answers explicitly when status is not approved.
    if (bp.status !== "approved" || bp.approved_by !== user.email) {
      return res.status(409).json({ error: "cast requires a fresh approval on the current draft (no casting of unapproved or stale-approved drafts)" });
    }

    // Stage 2 · revalidation on THE SAME draft (apply-phase recheck).
    const result = runBlueprintValidation(JSON.parse(bp.content_json));
    if (!result.ok) {
      return res.status(422).json({ error: "cast revalidation failed", stage: result.stage ?? null, errors: result.errors });
    }

    const manifest = result.manifest;
    manifest._casting = {
      source: "fleet-blueprint-studio",
      blueprint: bp.name,
      blueprintId: bp.id,
      version: bp.version,
      approvedBy: bp.approved_by,
      approvedAt: bp.approved_at,
      diffSummary: bp.diff_summary ?? null,
    };
    const posted = req.body ?? {};
    const packId = posted.packId ?? bp.cast_pack_id ?? null;

    let published;
    try {
      published = await publishClient.publish({ manifest, packId, author: user.email });
    } catch (e) {
      return res.status(502).json({ error: `publish channel failed: ${e.message}` });
    }
    if (!published?.ok) {
      return res.status(502).json({ error: "publish door refused the cast manifest", detail: published ?? null });
    }
    recordCast(db, bp.id, { packId: published.packId, packVersion: published.version });
    res.status(201).json({ ok: true, packId: published.packId, packVersion: published.version, status: "cast" });
  });

  // ── trial report (record + read; the runner lane ships with Slice 3) ─
  app.post("/api/blueprints/:id/trial-report", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    const report = req.body ?? {};
    if (typeof report !== "object" || Array.isArray(report)) return res.status(400).json({ error: "trial report must be an object" });
    saveTrialReport(db, bp.id, JSON.stringify(report));
    res.json({ ok: true });
  });

  app.get("/api/blueprints/:id/trial-report", (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const bp = getBlueprint(db, req.params.id);
    if (!bp || bp.owner_email !== user.email) return res.status(404).json({ error: "Blueprint not found" });
    res.json({ report: bp.trial_report_json ? JSON.parse(bp.trial_report_json) : null });
  });

  return app;
}

// ── default publish client (facet marketplace, proxy channel) ───────────
// Same channel publish_pack.py drives: POST /api/packs with the internal
// facet token. Reachable only on CAST — the studio never calls it earlier.

function defaultPublishClient() {
  return {
    async publish({ manifest, packId, author }) {
      const base = process.env.FACET_BASE_URL ?? "https://facet.finddatatech.cloud";
      const token = process.env.FACET_INTERNAL_TOKEN;
      if (!token) throw new Error("FACET_INTERNAL_TOKEN not configured on this host");
      const url = new URL("/api/packs", base);
      if (packId) url.searchParams.set("packId", packId);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-facet-token": token,
          "x-facet-user": author,
        },
        body: JSON.stringify(manifest),
      });
      const text = await resp.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
      if (!resp.ok) return { ok: false, status: resp.status, body };
      return { ok: true, packId: body?.id ?? body?.packId ?? packId, version: body?.version ?? null };
    },
  };
}
