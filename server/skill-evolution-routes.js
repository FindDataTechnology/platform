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
import { createEvalQueue } from "./eval-queue.js";
import { authorizeActor } from "../lib/precedent-grade.js";

export function createSkillEvolutionRoutes(app, ctx = null) {
  const store = skillEvolutionStore();
  // 自动取证 (openspec: owner-inbox)：候选落库即排队评测，人只做终审。
  const evalQueue = createEvalQueue({
    log: (m) => console.log(m),
    store,
    runEval: (args) => runSkillEval({ ...args, lane: resolveJudgeLane() }),
  });
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
    // 落库即排队取证 (openspec: owner-inbox)。响应不等评测——取证是几分钟的
    // 判定调用，把 propose 变成同步等待会让 agent 回合被它拖住；超预算时候选
    // 如实停在「未评测」，不是被丢弃。
    const queued = evalQueue.enqueueSkill(out.candidate);
    res.status(201).json({ ok: true, candidate: out.candidate, evaluation: queued });
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

  // Promotion: requires a green evaluation. The signature is structural, not
  // human-by-default (agent-decided-learning-loop D6): an actor may sign when
  // the independence graph holds (§ authorizeActor) OR it is a human.
  //
  // Seats, all server-held:
  //   proposer — `candidate.proposed_by`, written from the caller identity the
  //              auth layer resolved (never the request body). The MCP child
  //              proposes under its own internal stamp, so its proposals and a
  //              human's are distinguishable seats.
  //   decider  — the acting caller (an internal bridge email, or a real user)
  //   grader   — the A/B judge lane; its model RIDES the stored eval report
  //              (`report.lane.model`) and its input is blind by construction
  //              (arm names anonymised — pinned by the anonymity test).
  //
  // A real human keeps promoting exactly as before. A non-human decider must
  // clear the graph, and inherits the recorded grade from it.
  router.post("/candidates/:id/promote", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const cand = store.getCandidate(req.params.id);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    const isHuman = !String(user.email ?? "").endsWith("@internal");
    const judgeModel = cand.evalReport?.lane?.model ?? null;
    const auth = isHuman
      ? { ok: true, via: "human", grade: null }
      : authorizeActor({
          resolvedBy: null,
          seats: {
            proposer: cand.proposedBy ?? null,
            decider: user.email,
            grader: judgeModel ? "eval-lane" : null,
            // The judge and the decider are different systems even when the
            // model string matches, but the graph only trusts a comparison it
            // can show — so an absent decider model lands the promotion at
            // `-unverified` instead of claiming a second opinion.
            deciderModel: cand.evalReport?.deciderModel ?? null,
            graderModel: judgeModel,
            blind: Boolean(judgeModel),
          },
        });
    if (!auth.ok) return res.status(403).json({ error: auth.reason, code: "INDEPENDENCE_NOT_ESTABLISHED" });
    const out = store.promote(req.params.id, { by: user.email });
    if (out.error) return res.status(409).json({ error: out.error });
    // Front-end refresh ONLY. The skill is already on disk — store.promote()
    // materializes synchronously and rolls back on failure, so nothing
    // downstream may treat this broadcast as the thing that makes it live.
    ctx?.broadcast?.({ type: "skills_changed" });
    res.json({ ok: true, promoted: out.promoted, authorizedVia: auth.via, grade: auth.grade });
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
