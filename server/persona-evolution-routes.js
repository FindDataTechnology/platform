// ── Persona evolution routes (add-persona-self-evolution) ───────────────────
//
// REST face over personaEvolutionStore + the persona A/B harness. Auth
// semantics mirror skill-evolution-routes.js. The MCP child (persona_amend)
// drives ONLY /propose over the loopback bridge; evaluate, promote and reject
// are the OWNER's gestures — the tool face cannot reach them (double key).
//
// Promotion SPLITS by target (design D3):
//   - preset → db.updateUserPreset with the amended persona (the same path
//     the preset editor PUT rides; lineage stamps the old text on the
//     candidate — 可溯可回退), inside the serialized runtime-mutation window,
//     then the catalog sync + broadcast the preset editor does.
//   - pack → a fork DRAFT via packStore.createDraft (provenance.forkOf
//     stamped, amended persona inside) — the pack本体 and installed
//     snapshots are NEVER written (版本不可变既律).
//
// Session stability (D4): none of these writes hot-touch a running or parked
// session — presets re-cast at their own rhythm, exactly like a manual edit.

import { Router } from "express";
import * as dbModule from "../db.js";
import { personaEvolutionStore, currentPersonaFor, PERSONA_MAX_CHARS } from "./persona-evolution.js";
import { runPersonaEval } from "./persona-eval.js";
import { resolveJudgeLane } from "./blueprint-judge.js";

export function createPersonaEvolutionRoutes(app, ctx = null) {
  const store = personaEvolutionStore();
  const resolveUser = (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
  const requireUser = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return user;
  };

  const router = Router();
  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[persona-evolution-access] ${req.method} ${req.baseUrl}${req.path} ${resolveUser(req)?.email ?? "anon"}`);
    }
    next();
  });

  router.get("/candidates", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.json({ candidates: store.listCandidates(req.query.status ?? null) });
  });

  router.get("/candidates/:id", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cand = store.getCandidate(req.params.id);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    res.json({ candidate: cand });
  });

  // The MCP child's only write. Unknown targets and sanity-scan failures are
  // refused here (store re-checks too).
  router.post("/propose", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    // sourceDocId 可选：studio 工作区发起的提案带来源文档（8.1 回链）；
    // cell 内 MCP 提案不带——缺席诚实，评审面零芯片。
    const { targetKind, targetRef, agentId, amendedPersona, evidence, sourceDocId } = req.body ?? {};
    if (targetKind !== "preset" && targetKind !== "pack") {
      return res.status(400).json({ error: "targetKind must be 'preset' or 'pack'" });
    }
    if (typeof targetRef !== "string" || !targetRef.trim() || targetRef.length > 200) {
      return res.status(400).json({ error: "targetRef is required" });
    }
    if (targetKind === "pack" && (typeof agentId !== "string" || !agentId.trim())) {
      return res.status(400).json({ error: "pack targets require agentId" });
    }
    if (typeof amendedPersona !== "string" || amendedPersona.trim().length < 20) {
      return res.status(400).json({ error: "amendedPersona must be the FULL amended role text (≥20 chars)" });
    }
    if (amendedPersona.length > PERSONA_MAX_CHARS) {
      return res.status(400).json({ error: `amendedPersona exceeds ${PERSONA_MAX_CHARS} characters` });
    }
    if (!evidence || typeof evidence !== "object" || !String(evidence.source ?? "").trim() || !String(evidence.fixed ?? "").trim()) {
      return res.status(400).json({ error: "evidence is required (source turn / what it fixes) — 无证据的候选被拒" });
    }
    const current = currentPersonaFor({ targetKind, targetRef, agentId });
    if (current.error) return res.status(400).json({ error: current.error });
    const gate = store.proposeGate({ targetKind, targetRef, agentId });
    if (!gate.ok) return res.status(429).json({ error: gate.error, code: gate.code });
    const out = store.createCandidate({ targetKind, targetRef, agentId, amendedPersona, evidence, proposedBy: user.email, sourceDocId });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ ok: true, candidate: out.candidate });
  });

  // The owner's gesture. Runs the persona A/B harness synchronously (a
  // judge-lane call pair, seconds) and records the verdict either way. An
  // interrupted evaluation leaves the candidate in `candidate` status with an
  // honest reason — 评测没跑成 ≠ 通过.
  router.post("/candidates/:id/evaluate", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cand = store.getCandidate(req.params.id);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    if (cand.status === "promoted" || cand.status === "rejected") {
      return res.status(409).json({ error: `candidate already ${cand.status}` });
    }
    const scenarioPrompt = String(req.body?.scenarioPrompt ?? "").trim() || String(cand.evidence?.scenario ?? "").trim();
    try {
      const report = await runPersonaEval({
        currentPersona: cand.current_persona,
        amendedPersona: cand.amended_persona,
        scenarioPrompt,
        lane: resolveJudgeLane(),
      });
      store.saveEvalReport(cand.id, report);
      if (report.passed) store.markEvaluated(cand.id);
      else store.markUnevaluated(cand.id, `gate not passed: ${report.reason}`);
      res.json({ ok: true, passed: report.passed, reason: report.reason, report });
    } catch (err) {
      store.markUnevaluated(cand.id, String(err.message ?? err));
      res.status(502).json({ ok: false, error: "evaluation failed", reason: String(err.message ?? err) });
    }
  });

  // Promotion: human-only, requires a green evaluation (the double key), and
  // SPLITS by target — custom preset materializes; pack persona forks.
  router.post("/candidates/:id/promote", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cand = store.getCandidate(req.params.id);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });

    if (cand.target_kind === "preset") {
      const preset = dbModule.getDb().prepare(`SELECT id, persona FROM user_presets WHERE id = ?`).get(cand.target_ref);
      if (!preset) return res.status(409).json({ error: `preset '${cand.target_ref}' no longer exists` });
      const apply = async () => {
        dbModule.updateUserPreset(cand.target_ref, { persona: cand.amended_persona });
        ctx?.broadcast?.({ type: "catalog_changed" });
        await ctx?.syncCatalogAgentPresets?.();
      };
      if (ctx?.isStreaming) return res.status(409).json({ error: "Cannot manage presets while the agent is responding" });
      try {
        if (ctx?.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(apply);
        else await apply();
      } catch (err) {
        return res.status(500).json({ error: `preset materialization failed: ${err.message ?? err}` });
      }
      const out = store.markPromoted(cand.id, {
        by: user.email,
        outcome: { kind: "preset", presetId: cand.target_ref, previousPersona: preset.persona ?? null },
      });
      if (out.error) return res.status(409).json({ error: out.error });
      return res.json({ ok: true, promoted: { kind: "preset", presetId: cand.target_ref } });
    }

    if (cand.target_kind === "pack") {
      // Pack personas are forked, never written (design D3): a fork DRAFT in
      // the drafts store with provenance.forkOf stamped and the amended
      // persona inside. The pack本体 and installed snapshots stay untouched.
      const pack = dbModule.listInstalledPacks().find((p) => p.packId === cand.target_ref);
      let manifest = pack?.manifest;
      if (typeof manifest === "string") {
        try { manifest = JSON.parse(manifest); } catch { manifest = null; }
      }
      if (!manifest) return res.status(409).json({ error: `pack '${cand.target_ref}' manifest unreadable` });
      const sourceAgent = (manifest.agents ?? []).find((a) => a.id === cand.agent_id);
      if (!sourceAgent) return res.status(409).json({ error: `pack '${cand.target_ref}' does not declare agent '${cand.agent_id}'` });
      const store2 = ctx?.packStore;
      if (!store2?.createDraft) return res.status(503).json({ error: "drafts store unavailable" });
      const forkedManifest = {
        ...manifest,
        agents: (manifest.agents ?? []).map((a) => (a.id === cand.agent_id ? { ...a, persona: cand.amended_persona } : a)),
        provenance: { ...manifest.provenance, forkOf: { packId: cand.target_ref, version: pack.version ?? null } },
      };
      let draft;
      try {
        draft = store2.createDraft({
          name: `${manifest.name ?? cand.target_ref} (persona fork)`,
          manifest: forkedManifest,
        });
      } catch (err) {
        return res.status(500).json({ error: `fork draft creation failed: ${err.message ?? err}` });
      }
      const out = store.markPromoted(cand.id, {
        by: user.email,
        outcome: { kind: "fork-draft", draftId: draft?.draft?.id ?? draft?.id ?? null, packId: cand.target_ref, agentId: cand.agent_id },
      });
      if (out.error) return res.status(409).json({ error: out.error });
      return res.json({ ok: true, promoted: { kind: "fork-draft", packId: cand.target_ref, agentId: cand.agent_id } });
    }

    return res.status(400).json({ error: `unknown target kind '${cand.target_kind}'` });
  });

  router.post("/candidates/:id/reject", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = store.reject(req.params.id, { by: user.email, reason: String(req.body?.reason ?? "").slice(0, 500) || null });
    if (out.error) return res.status(409).json({ error: out.error });
    res.json({ ok: true, rejected: out.rejected });
  });

  app.use("/api/persona-evolution", router);
}
