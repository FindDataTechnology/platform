// ── Revision governance routes (harden-agent-runtime-spine, runtime-revision 5.3–5.5) ─
//
// Promote and roll back a deployment's running CONFIGURATION, with the two
// refusals that make "roll back to the version that worked" a safe sentence:
//
//   • promote without a green trial under the SAME fingerprint is refused
//     (an audited human override is allowed, and recorded);
//   · rollback to a target that no longer reproduces its fingerprint is
//     refused as divergence (a drifted dependency means the label lies).
//
// The routes never mint a fingerprint — that is the compose seam's job (the
// runner computes it from the materialized home). This layer owns the decision
// and the audit; it says so when it cannot judge rather than assuming.
//
// Trust model: same owner gate as the rest of the fleet surface (`requireOwner`
// from the caller). No new credential, no new surface.

import { decidePromotion, decideRollback, governanceRecord, revisionRecord, attachTrial } from "../../lib/runtime-revision.js";
import { createRevisionStore } from "../../lib/revision-store.js";

/**
 * @param {object} p
 * @param {import("express").Express} p.app
 * @param {() => import("better-sqlite3").Database} p.getDb   the fleet DB
 * @param {(req) => object|null} p.requireOwner                resolved owner gate
 * @param {(deployment: string) => Promise<string|null>} [p.fingerprintOf]
 *        re-materialize the ACTIVE config and hash it — the rollback's proof
 */
export function registerRevisionRoutes({ app, getDb, requireOwner, fingerprintOf = null, log = console }) {
  const store = () => createRevisionStore({ db: getDb().db ?? getDb() });
  // Owner gate: the routes are fleet-surface routes, so the SAME rule applies
  // (an unknown owner is a 403, never a 500 — the gate answers).
  const gate = (req, res) => {
    const owner = requireOwner(req);
    if (!owner) {
      res.status(403).json({ error: { code: "NOT_OWNER", message: "this deployment is not yours" } });
      return null;
    }
    return owner;
  };
  const deploymentOf = (req) => String(req.params.deployment ?? "").trim();

  app.get("/api/revisions/:deployment", (req, res) => {
    if (!gate(req, res)) return;
    const deployment = deploymentOf(req);
    if (!deployment) return res.status(400).json({ error: { code: "DEPLOYMENT_REQUIRED" } });
    try {
      const s = store();
      const active = s.active(deployment);
      return res.json({
        deployment,
        // Explicitly null on a deployment that never promoted: "no active
        // revision" is a state, not an error.
        active: active ?? null,
        revisions: s.list(deployment),
        governance: s.governance(deployment),
      });
    } catch (e) {
      log.warn?.(`[revisions] list failed for ${deployment}: ${e?.message || e}`);
      return res.status(500).json({ error: { code: "REVISIONS_UNAVAILABLE", message: String(e?.message || e) } });
    }
  });

  app.post("/api/revisions/:deployment", (req, res) => {
    const owner = gate(req, res);
    if (!owner) return;
    const deployment = deploymentOf(req);
    const body = req.body ?? {};
    if (!body.fingerprint) {
      return res.status(400).json({ error: { code: "FINGERPRINT_REQUIRED", message: "a revision's identity is its content; supply the fingerprint the compose seam computed" } });
    }
    try {
      const s = store();
      let rev = revisionRecord({
        fingerprint: String(body.fingerprint),
        name: body.name ?? null,
        packId: body.packId ?? deployment,
        packVersion: body.packVersion ?? null,
        overrides: body.overrides ?? null,
        state: "candidate",
      });
      rev.deployment = deployment;
      if (body.trial) {
        const attached = attachTrial(rev, body.trial);
        // A trial about a different build is refused HERE, not stored as if it
        // were about this one.
        if (!attached.ok) return res.status(409).json({ error: { code: attached.reason, ...attached } });
        rev = attached.revision;
      }
      const stored = s.record(rev);
      return res.status(201).json({ deployment, revision: stored });
    } catch (e) {
      return res.status(500).json({ error: { code: "REVISION_WRITE_FAILED", message: String(e?.message || e) } });
    }
  });

  app.post("/api/revisions/:deployment/promote", (req, res) => {
    const owner = gate(req, res);
    if (!owner) return;
    const deployment = deploymentOf(req);
    const body = req.body ?? {};
    const revisionId = String(body.revisionId ?? "");
    if (!revisionId) return res.status(400).json({ error: { code: "REVISION_REQUIRED" } });
    try {
      const s = store();
      const target = s.get(deployment, revisionId);
      if (!target) return res.status(404).json({ error: { code: "REVISION_NOT_FOUND" } });
      const current = s.active(deployment);
      const decision = decidePromotion({
        target,
        currentFingerprint: current?.fingerprint ?? null,
        humanOverride: body.override === true,
        overrideReason: body.overrideReason ?? null,
        overriddenBy: body.override ? owner.email ?? owner.id ?? "owner" : null,
      });
      if (!decision.ok) return res.status(409).json({ error: { code: decision.reason, ...decision } });
      if (decision.noop) return res.json({ deployment, moved: false, active: current, decision });
      const moved = s.movePointer(deployment, revisionId, {
        action: "promote",
        by: owner.email ?? owner.id ?? "owner",
        reason: body.reason ?? null,
        overridden: decision.overridden === true,
        overrideReason: decision.override?.reason ?? null,
      });
      return res.json({ deployment, moved: true, ...moved, decision, audit: governanceRecord({ action: "promote", from: moved.before, to: moved.after, by: owner.email ?? null, reason: body.reason ?? null, overridden: decision.overridden === true }) });
    } catch (e) {
      return res.status(500).json({ error: { code: "PROMOTE_FAILED", message: String(e?.message || e) } });
    }
  });

  app.post("/api/revisions/:deployment/rollback", async (req, res) => {
    const owner = gate(req, res);
    if (!owner) return;
    const deployment = deploymentOf(req);
    const body = req.body ?? {};
    const revisionId = String(body.revisionId ?? "");
    if (!revisionId) return res.status(400).json({ error: { code: "REVISION_REQUIRED" } });
    try {
      const s = store();
      const target = s.get(deployment, revisionId);
      if (!target) return res.status(404).json({ error: { code: "REVISION_NOT_FOUND" } });
      // The proof: re-materialize the target NOW and hash it. No injector means
      // we cannot prove reproducibility, and decideRollback refuses rather
      // than trusting the label.
      let reproduced = null;
      if (typeof fingerprintOf === "function") {
        try {
          reproduced = await fingerprintOf(deployment);
        } catch (e) {
          log.warn?.(`[revisions] fingerprintOf failed for ${deployment}: ${e?.message || e}`);
        }
      }
      const decision = decideRollback({ target, currentFingerprintOfTarget: reproduced });
      if (!decision.ok) return res.status(409).json({ error: { code: decision.reason, ...decision } });
      const current = s.active(deployment);
      const moved = s.movePointer(deployment, revisionId, { action: "rollback", by: owner.email ?? owner.id ?? "owner", reason: body.reason ?? null });
      return res.json({ deployment, moved: true, ...moved, decision, audit: governanceRecord({ action: "rollback", from: current?.revisionId ?? null, to: revisionId, by: owner.email ?? null, reason: body.reason ?? null }) });
    } catch (e) {
      return res.status(500).json({ error: { code: "ROLLBACK_FAILED", message: String(e?.message ?? e) } });
    }
  });
}
