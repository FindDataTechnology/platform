// ── Delegation REST bridge ───────────────────────────────────────────────────
//
// Thin HTTP surface over the task engine's manual-trigger path (spec:
// agent-delegation-tools). Consumer: the in-cell delegation MCP child
// (server/delegation-mcp.js), authenticated by the loopback-only exemption in
// server/auth.js (the cron bridge's credential model). The child cannot call
// the engine in-process, and the engine's write chain must stay single-writer.
//
// The bridge resolves the initiating session and current persona SERVER-side:
// the MCP child runs inside the dsh runtime and has no web-session identity,
// but the persona mid-conversation IS the cell's current preset and its
// conversation IS the current session — exactly the initiator semantics.

import { Router } from "express";
import * as engine from "../../task-engine.js";
import * as chatHistory from "../../chat-history.js";

export function registerDelegationRoutes(ctx) {
  const app = ctx.app;
  const router = Router();

  // Create (and immediately enqueue) a manual task targeting another persona.
  router.post("/tasks", async (req, res) => {
    try {
      const persona = req.body?.persona;
      const prompt = req.body?.prompt;
      if (!persona || typeof persona !== "string") {
        return res.status(400).json({ error: "a target persona is required" });
      }
      if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "prompt is required" });
      }
      // Self-delegation is rejected: the running persona delegating to itself
      // is a no-op loop, not a fan-out (spec scenario).
      const current = ctx.currentPreset;
      if (persona === current) {
        return res.status(400).json({
          error: `the conversation is already running under ${persona}; delegate to a different persona`,
        });
      }
      const task = engine.createManualTask({
        prompt,
        persona,
        sessionTitle: req.body?.name || null,
        initiator: chatHistory.currentSessionId(),
        // The persona the conversation runs under — the aggregator switches
        // back to it before injecting the summary (the fan-out leaves the
        // runtime on the last target persona).
        initiatorPreset: current ?? null,
      });
      res.status(201).json({ task });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Live progress of the current session's delegated tasks (manual trigger,
  // this initiator). `all=1` includes aggregated ones for history reads.
  router.get("/tasks", (req, res) => {
    const initiator = chatHistory.currentSessionId();
    const all = req.query.all === "1";
    const tasks = engine
      .listTasks()
      .filter((t) => t.trigger === "manual" && (all || !t.aggregated))
      .filter((t) => t.initiator === null || t.initiator === initiator);
    res.json({ tasks });
  });

  // A finished task's recorded output (or error gist) — read from the task's
  // dedicated session history, the same store the chat UI renders.
  router.get("/tasks/:id/result", async (req, res) => {
    const t = engine.getTask(req.params.id);
    if (!t || t.trigger !== "manual") {
      return res.status(404).json({ error: `no delegated task ${req.params.id}` });
    }
    const last = t.history[t.history.length - 1] ?? null;
    let output = null;
    try {
      const sess = await chatHistory.getSession(t.sessionId);
      const asst = (sess?.messages || []).filter((m) => m.role === "assistant");
      if (asst.length) output = asst[asst.length - 1].content || "";
    } catch { /* empty/unknown session → output stays null */ }
    res.json({
      id: t.id,
      state: t.state,
      prompt: t.prompt,
      persona: t.target?.ref ?? null,
      output,
      error: t.error ?? null,
      tokens: last?.tokens ?? null,
      finishedAt: last?.time ?? null,
    });
  });

  app.use("/api/delegation", router);
}
