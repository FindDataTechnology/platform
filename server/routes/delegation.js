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
import * as catalog from "../../catalog.js";

export function registerDelegationRoutes(ctx) {
  const app = ctx.app;
  const router = Router();

  // Online market a2a entries — the discovery view behind search_agents and
  // the delegate description's category summary (spec: agent-delegation-a2a;
  // one catalog view serves humans and delegation alike, no separate store).
  function onlineA2aAgents() {
    // getChatAgentEntries() filters mode==="chat" — the a2a family needs its
    // own slice of the same merged view (registry-sourced a2a entries, spec:
    // agent-catalog). Category falls back to the first tag; tags ride through.
    return catalog
      .listAgents()
      .filter((e) => e.type === "agent-remote" && e.mode === "a2a")
      .map((e) => ({
        id: e.id,
        name: e.name ?? e.id,
        description: e.description ?? "",
        category: e.category ?? (Array.isArray(e.tags) && e.tags[0] ? String(e.tags[0]) : ""),
        tags: Array.isArray(e.tags) ? e.tags : [],
      }));
  }

  // Create (and immediately enqueue) a manual task targeting another persona
  // OR a market a2a agent (add-agent-delegation-a2a).
  router.post("/tasks", async (req, res) => {
    try {
      const persona = req.body?.persona;
      const agent = req.body?.agent;
      const prompt = req.body?.prompt;
      if (!persona && !agent) {
        return res.status(400).json({ error: "a target persona or market agent is required" });
      }
      if (persona && agent) {
        return res.status(400).json({ error: "target either a persona or a market agent, not both" });
      }
      if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "prompt is required" });
      }
      const current = ctx.currentPreset;
      if (agent) {
        // Unknown-target refusal happens at CREATION (spec scenario): the ref
        // must resolve to an online catalog a2a entry.
        const entry = catalog.getAgentEntry(agent);
        if (!entry || entry.mode !== "a2a") {
          return res.status(400).json({ error: `unknown market agent '${agent}' — call search_agents for candidates` });
        }
        const task = engine.createManualTask({
          prompt,
          agent,
          sessionTitle: req.body?.name || null,
          initiator: chatHistory.currentSessionId(),
          initiatorPreset: current ?? null,
        });
        return res.status(201).json({ task });
      }
      // Self-delegation is rejected: the running persona delegating to itself
      // is a no-op loop, not a fan-out (spec scenario). Persona targets only —
      // an a2a target is always another agent by construction.
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

  // Two-level discovery (spec: agent-delegation-a2a): keyword search over the
  // online a2a entries; `summary=1` answers the category counts for the
  // delegate description. Same view as the human catalog.
  router.get("/agents", (req, res) => {
    const all = onlineA2aAgents();
    if (req.query.summary === "1") {
      const counts = {};
      for (const a of all) counts[a.category || "其他"] = (counts[a.category || "其他"] ?? 0) + 1;
      return res.json({ total: all.length, categories: counts });
    }
    const q = String(req.query.search || "").trim().toLowerCase();
    const scored = all
      .map((a) => {
        const hay = `${a.id} ${a.name} ${a.description} ${a.category} ${a.tags.join(" ")}`.toLowerCase();
        return { a, hit: q ? hay.includes(q) : true };
      })
      .filter((x) => x.hit)
      .slice(0, 8);
    res.json({ agents: scored.map((x) => x.a) });
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
