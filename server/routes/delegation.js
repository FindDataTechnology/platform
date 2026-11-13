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
import { rosterPresetId } from "../../dsh-profile.js";
import { searchAgentsView } from "../agent-discovery.js";

// Facade a2a target matching (add-principal-facade): a declared ref matches
// a catalog entry by exact id, or by registry path form embedded in the
// entry's reverse-proxy url. Module-level so the matching rule has one
// definition and one test face.
export function a2aRefMatches(ref, entry) {
  if (ref === entry.id) return true;
  const url = String(entry.url ?? "");
  return url !== "" && url.includes(String(ref));
}

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
        // Facade delegation matching (add-principal-facade) needs the entry's
        // registry path form; the search face carrying it is additive.
        url: e.url ?? "",
      }));
  }

  // Facade delegation bound (add-principal-facade): when the conversation
  // runs under a facade pack's reception role, its declared delegation list
  // is the whole specialist face — targets outside the list are refused at
  // creation and invisible to search. An absent or empty list = pure
  // reception (no delegation at all). In-pack refs name the pack's own roles
  // (cell personas after install); a2a refs name market targets (catalog id
  // or registry path form). Guarded on ctx.db so test/legacy mounts without
  // a packs store keep the unbounded behavior byte-for-byte.
  function facadeBoundFor(presetId) {
    if (!presetId || typeof ctx.db?.listInstalledPacks !== "function") return null;
    for (const installed of ctx.db.listInstalledPacks()) {
      const f = installed?.manifest?.facade;
      if (f && f.reception === presetId) return f;
    }
    return null;
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
      // Facade bound (add-principal-facade): the reception role's declared
      // list is the whole delegation face. Computed once; a null bound (no
      // facade, no db, or a non-reception preset) leaves every path unchanged.
      const bound = facadeBoundFor(current);
      if (agent) {
        // The pure-reception refusal precedes target resolution: the bound is
        // the initiator's property and must not leak whether a target exists.
        if (bound && (Array.isArray(bound.delegation) ? bound.delegation : []).length === 0) {
          return res.status(400).json({ error: "this facade's reception role declares no delegation face (pure reception)" });
        }
        // Unknown-target refusal happens at CREATION (spec scenario): the ref
        // must resolve to an online catalog a2a entry.
        const entry = catalog.getAgentEntry(agent);
        if (!entry || entry.mode !== "a2a") {
          return res.status(400).json({ error: `unknown market agent '${agent}' — call search_agents for candidates` });
        }
        if (bound) {
          const list = Array.isArray(bound.delegation) ? bound.delegation : [];
          if (!list.some((d) => d?.kind === "a2a" && a2aRefMatches(d.ref, entry))) {
            return res.status(400).json({ error: `market agent '${agent}' is not in this facade's delegation list` });
          }
        }
        const task = engine.createManualTask({
          prompt,
          agent,
          sessionTitle: req.body?.name || null,
          initiator: chatHistory.currentSessionId(),
          initiatorPreset: current ?? null,
          // 同上（fix-delegated-round-admission）：a2a 委托也是"有人要求了这一轮"。
          humanPriority: true,
        });
        return res.status(201).json({ task });
      }
      // Self-delegation is rejected: the running persona delegating to itself
      // is a no-op loop, not a fan-out (spec scenario). Persona targets only —
      // an a2a target is always another agent by construction.
      //
      // 同一身份两种拼法的折点（2026-11-12 实测）：目录/预设 API 的 id 是
      // `user.preset-7`（点号），运行期 roster 目录名只允许 [a-z0-9-]，于是是
      // `user-preset-7`（`dsh-profile.js:rosterPresetId` 那条注释写明了"catalog
      // keeps the original id"）。集群派发那条路已经折过（`fleets.js` 用
      // `rosterPresetId(target.targetId)`），**这条没有**——模型按它看到的名册
      // 原样传点号形式时，落库 `preset=user.preset-7`、执行期直接
      // `Unknown agent preset: user.preset-7`（实测 task_1794475327486_gg928n）。
      // 折在入口，落库就是运行期真能解析的那个 id。
      const targetPersona = rosterPresetId(persona);
      if (targetPersona === rosterPresetId(current)) {
        return res.status(400).json({
          error: `the conversation is already running under ${persona}; delegate to a different persona`,
        });
      }
      if (bound) {
        const list = Array.isArray(bound.delegation) ? bound.delegation : [];
        if (list.length === 0) {
          return res.status(400).json({ error: "this facade's reception role declares no delegation face (pure reception)" });
        }
        if (!list.some((d) => d?.kind === "in-pack" && rosterPresetId(d.ref) === targetPersona)) {
          return res.status(400).json({ error: `persona '${persona}' is not in this facade's delegation list` });
        }
      }
      const task = engine.createManualTask({
        prompt,
        persona: targetPersona,
        sessionTitle: req.body?.name || null,
        initiator: chatHistory.currentSessionId(),
        // The persona the conversation runs under — the aggregator switches
        // back to it before injecting the summary (the fan-out leaves the
        // runtime on the last target persona).
        initiatorPreset: current ?? null,
        // 对话里有人要求了这一轮 ⇒ 与主人的 execute-now 同一档
        // (fix-delegated-round-admission)。不带这个标记，委托轮在准入与池挑选里
        // 与"定时轮"完全同形：满负荷时只有人类优先轮能越过 cap 拿那个额外席位，
        // 其余一律按队头取；而 manual 又不按年龄丢 ⇒ 表现为「已入队、永不执行、
        // 零报错」（2026-11-12 cell 1da519d4c1c0bf89 实测：5 条 manual 全 hist=0、
        // 4 条 cadence 在正常轮转）。
        humanPriority: true,
      });
      res.status(201).json({ task });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Two-level discovery (spec: agent-delegation-a2a): keyword search over the
  // online a2a entries; `summary=1` answers the category counts for the
  // delegate description. Same view as the human catalog — narrowed to the
  // facade's declared a2a targets when the conversation runs under its
  // reception (an empty declaration yields an empty view: nothing to find).
  router.get("/agents", (req, res) => {
    let all = onlineA2aAgents();
    const bound = facadeBoundFor(ctx.currentPreset);
    if (bound) {
      const refs = (Array.isArray(bound.delegation) ? bound.delegation : []).filter((d) => d?.kind === "a2a");
      all = refs.length ? all.filter((a) => refs.some((d) => a2aRefMatches(d.ref, a))) : [];
    }
    if (req.query.summary === "1") {
      const counts = {};
      for (const a of all) counts[a.category || "其他"] = (counts[a.category || "其他"] ?? 0) + 1;
      return res.json({ total: all.length, categories: counts });
    }
    res.json(searchAgentsView({ all, search: req.query.search, limit: req.query.limit }));
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
