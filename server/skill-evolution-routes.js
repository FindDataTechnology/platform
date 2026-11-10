// ── Skill evolution routes (add-skill-self-evolution) ───────────────────────
//
// REST face over skillEvolutionStore + the A/B harness. Auth semantics mirror
// fleets.js: auth-on reads the forward-auth/logto user, auth-off the machine
// owner. The MCP child (skill_propose) drives ONLY /propose over the loopback
// bridge; evaluation, promote and reject are the OWNER's gestures — the tool
// face cannot reach them (route-level narrowness, matching the builder
// bridges' discipline).

import { Router } from "express";
import * as dbModule from "../db.js";
import { skillEvolutionStore } from "./skill-evolution.js";
import { runSkillEval } from "./skill-eval.js";
import { resolveJudgeLane } from "./blueprint-judge.js";

export function createSkillEvolutionRoutes(app, ctx = null) {
  const store = skillEvolutionStore();
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
      console.log(`[skill-evolution-access] ${req.method} ${req.baseUrl}${req.path} ${resolveUser(req)?.email ?? "anon"}`);
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

  // The MCP child's only write. Pack-owned supersedes targets and unknown
  // skills are refused here (store re-checks too) — pack skills are not
  // evolvable.
  router.post("/propose", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    // sourceDocId 可选：studio 工作区发起的提案带来源文档（8.1 回链）；
    // cell 内 MCP 提案不带——缺席诚实，评审面零芯片。
    const { name, description, body, evidence, supersedes, sourceDocId } = req.body ?? {};
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      return res.status(400).json({ error: "name must match [A-Za-z0-9._-]{1,64}" });
    }
    if (typeof body !== "string" || body.trim().length < 30) {
      return res.status(400).json({ error: "body must be a SKILL.md-shaped guidance (≥30 chars)" });
    }
    if (typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }
    if (!evidence || typeof evidence !== "object" || !String(evidence.source ?? "").trim()) {
      return res.status(400).json({ error: "evidence is required (source turn / what it solved) — 无证据的候选被拒" });
    }
    const gate = store.proposeGate({ name });
    if (!gate.ok) return res.status(429).json({ error: gate.error, code: gate.code });
    const out = store.createCandidate({ name, description, body, evidence, supersedes, proposedBy: user.email, sourceDocId });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ ok: true, candidate: out.candidate });
  });

  // The owner's gesture. Runs the A/B harness synchronously (a judge-lane
  // call pair, seconds) and records the verdict either way. An interrupted
  // evaluation leaves the candidate in `candidate` status with an honest
  // reason — 评测没跑成 ≠ 通过.
  router.post("/candidates/:id/evaluate", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cand = store.getCandidate(req.params.id);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    if (cand.status === "promoted" || cand.status === "rejected") {
      return res.status(409).json({ error: `candidate already ${cand.status}` });
    }
    const scenarioPrompt = String(req.body?.scenarioPrompt ?? "").trim() || String(cand.evidence?.scenario ?? "").trim();
    let oldBody = null;
    if (cand.supersedes) {
      oldBody = dbModule.getDb().prepare(`SELECT content FROM custom_skills WHERE name = ?`).get(cand.supersedes)?.content ?? null;
    }
    try {
      const report = await runSkillEval({
        candidate: { body: cand.body, supersedes: cand.supersedes },
        scenarioPrompt,
        lane: resolveJudgeLane(),
        oldSkillBody: oldBody,
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

  // Promotion: human-only, requires a green evaluation (the double key —
  // AI evidence, human signature).
  router.post("/candidates/:id/promote", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = store.promote(req.params.id, { by: user.email });
    if (out.error) return res.status(409).json({ error: out.error });
    ctx?.broadcast?.({ type: "skills_changed" });
    res.json({ ok: true, promoted: out.promoted });
  });

  router.post("/candidates/:id/reject", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const out = store.reject(req.params.id, { by: user.email, reason: String(req.body?.reason ?? "").slice(0, 500) || null });
    if (out.error) return res.status(409).json({ error: out.error });
    res.json({ ok: true, rejected: out.rejected });
  });

  app.use("/api/skill-evolution", router);
}
