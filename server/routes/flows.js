// ── Flow routes: the four verbs (add-task-flow, tasks 5.1–5.5) ──────────────
//
// Four writes and nothing else: create / dispatch / accept / return. Every one
// of them lands on a task-engine semantic that already exists — this file adds
// the flow vocabulary, not a second executor.
//
// The one rule that shapes the whole file: a card is a task (design D1). There
// is no card store; `flow` rides the task record as passthrough data and the
// engine's own `setTaskFlow` is the only writer.
//
// `deps` is injected so tests (and the desktop build) can supply resolvers
// without loading the whole catalog: { exists, judge, resolveFlow, resolveTarget }.

import { Router } from "express";
import * as engine from "../../task-engine.js";
import { catalogPresetId, rosterPresetId, knownPresetIds } from "../../dsh-profile.js";
import { targetRunnable } from "../fleet-target-runnable.js";
import { splitToolTarget } from "../tool-turn.js";
import { resolveStdioServerConfig } from "../../lib/action-executor.js";
import {
  validateFlowDeclaration,
  normalizeFlowDeclaration,
  resolveStationTarget,
  evaluateAcceptance,
  reassignCard,
  stampAcceptance,
  evidenceFromExecution,
} from "../task-flow.js";
import { getTaskFlowDatabase } from "../task-flow-db.js";
import { readUsageWindow, attributeUsage, cardWindow } from "../sub2api-usage.js";

const ACTOR_OF = (req) => req.user?.email ?? null;

// Owner of a card. Same fallback chain the machines routes use: auth-off
// deployments (desktop / standalone) have no req.user, and there the requester
// IS the owner. Without the fallback every card would be ownerless and the
// inbox lane would be empty on exactly the deployment type most people run.
const OWNER_OF = (req, ctx) => req.user?.email ?? ctx?.cellUserEmail ?? (ctx?.authEnabled ? null : "owner@local");

// Who may see which cards. Auth-off keeps the single-user contract (every card
// visible — a board that is empty on a desktop install is a bug, not security);
// an admin sees the whole instance; everyone else sees exactly the cards they
// own. Kept next to OWNER_OF so the write-side owner and the read-side viewer
// are one decision, not two that can drift.
const boardViewerOf = (req, ctx) => {
  const includeAll = !ctx?.authEnabled || Boolean(ctx?.isAdminUser?.(req.user));
  return { includeAll, email: OWNER_OF(req, ctx) };
};

// The four existence checkers the flow layer asks about a station's target.
//
// persona has TWO legitimate spellings and they live in two different stores —
// asking only one is how a station ends up "vacant" for every persona a real
// cell actually runs:
//
//   1. a ROSTER preset (standard / code / a user preset). This is what a
//      session can actually run as, and it is the built-in path.
//   2. a CATALOG agent-remote chat entry — the fleet `resolveTarget` view,
//      which is what a fleet post targets.
//
// The delegation face learned this the same way (2026-11-15: asking only the
// dotted form rejected every roster-spelled delegation). So the checker asks
// both, and a station is resolvable if EITHER answers.
//
// a2a / cluster / tool: the catalog / cluster store / tool registry when the
// hosting server injects them. Absent those the checker returns false, and
// resolveStationTarget turns that into an honest "unresolved" — never a
// fallback to whatever runtime happens to be live.
function existCheckers(ctx = {}) {
  const onRoster = (ref) => {
    try {
      const ids = knownPresetIds();
      if (ids.has(ref)) return true;
      const dashed = rosterPresetId(ref);
      return dashed !== ref && ids.has(dashed);
    } catch {
      return false;
    }
  };
  const inCatalog = (ref) => {
    const resolve = ctx?.fleetTargetResolver;
    if (typeof resolve !== "function") return false;
    const runs = (id) => targetRunnable({ title: ref, targetKind: "persona", targetId: id }, resolve).ok;
    if (runs(ref)) return true;
    const dashed = catalogPresetId(ref);
    return dashed !== ref && runs(dashed);
  };
  const persona = (ref) => onRoster(ref) || inCatalog(ref);
  return {
    persona,
    // An auditor post is persona-backed (the fleet layer's fifth kind); it must
    // not read as "unknown kind" — the 2026-11-10 incident where a dozen
    // scattered `=== "persona"` comparisons each degraded silently.
    auditor: persona,
    a2a: (ref) => Boolean(ctx.resolveA2a?.(ref)),
    cluster: (ref) => Boolean(ctx.resolveCluster?.(ref)),
    // tool: "server::tool" — resolvable when the named MCP server is actually
    // configured (bundle manifest or mcp.json). The TOOL itself is judged at
    // run time, honestly, because MCP tool surfaces drift (the fleet dispatch
    // face makes the same split). Asking an injected resolver here would be the
    // third copy of a question this platform already answers in one place.
    tool: (ref) => {
      const split = splitToolTarget(ref);
      if (!split) return false;
      try {
        return Boolean(resolveStdioServerConfig(split.server));
      } catch {
        return false;
      }
    },
  };
}

export function registerFlowRoutes(ctx, deps = {}) {
  const { app } = ctx;
  const router = Router();
  const flowDb = () => ctx.taskFlowDatabase ?? getTaskFlowDatabase();

  // Existence checkers, per target kind. Production wires these to the SAME
  // resolvers the delegation and fleet-dispatch faces use; a test injects its
  // own. There is deliberately NO fallback: a missing checker makes
  // resolveStationTarget refuse, because "we could not prove it exists" must
  // never become "run it anyway" (the shape fix-dispatch-to-parked-post fixed).
  //
  // persona resolution goes through `targetRunnable` — the ONE "can this post
  // produce a turn" predicate — rather than a private `=== "persona"` check,
  // and it tries both the dashed and dotted preset spellings (measured
  // 2026-11-15: asking only one form rejects every roster-spelled delegation).
  const exists = deps.exists ?? ctx?.flowExists ?? existCheckers(ctx);
  const judge = deps.judge ?? ctx.flowJudge ?? null;
  const getFlow = deps.getFlow ?? ((id) => flowDb().getFlow(id));
  const stationOf = (flow, stationId) => (flow?.stations ?? []).find((s) => s.stationId === stationId) ?? null;

  // ── Flow declarations ─────────────────────────────────────────────────────

  router.get("/", (_req, res) => {
    res.json({ flows: flowDb().listFlows() });
  });

  // ── The board read (task 6.1) ─────────────────────────────────────────────
  //
  // One read that the UI needs and nothing more. It is a PROJECTION: cards come
  // from the engine's own list, flows from the declaration store, dependencies
  // from the dep table. No column is decided here — `columnOf` on the client is
  // the single mapping, so three clients cannot disagree about what "review"
  // means.
  router.get("/board", async (req, res) => {
    const viewer = boardViewerOf(req, ctx);
    const all = engine
      .listTasks()
      .filter((t) => t.flow && t.flow.flowId);
    // Ownership is an AUTHORIZATION fact, so it is applied here, never on the
    // client: a filtered-on-the-client response has already crossed the wire,
    // which is the shape that gets misread as "just not displayed".
    //
    // The count of withheld cards rides the payload as `unscoped` because the
    // alternative is worse: after this lands, a board that suddenly shows fewer
    // cards with no explanation is exactly the "self-consistent but smaller"
    // defect the agent-run-board spec keeps writing rules against. We do not
    // leak their content — only how many exist.
    const visible = all.filter((t) => viewer.includeAll || (t.flow.owner ?? null) === viewer.email);
    const unscoped = all.length - visible.length;

    // Completion cost: read the billing truth once for the board's time span
    // and attribute each usage row to the one card whose execution window
    // contains it. Overlapping windows stay unknown rather than double count.
    // Any failure leaves the map empty; the readout then says unknown.
    let costById = new Map();
    try {
      const windows = visible.map(cardWindow).filter(Boolean);
      if (windows.length > 0 && process.env.LLM_API_KEY && process.env.LLM_BASE_URL) {
        const start = Math.min(...windows.map((w) => w.start));
        const end = Math.max(...windows.map((w) => w.end));
        const rows = await readUsageWindow({ start, end });
        costById = attributeUsage(rows, visible);
      }
    } catch {
      costById = new Map();
    }

    const cards = visible.map((t) => {
      const cost = costById.get(t.id);
      return {
        ...t,
        blockedBy: flowDb().blockersOf(t.id),
        ...(cost
          ? {
              cost_usd: cost.ambiguous ? null : cost.usd,
              cost_basis: cost.ambiguous ? null : "sub2api_actual_cost",
              cost_unknown_reason: cost.ambiguous ? "usage window overlaps multiple cards" : null,
            }
          : {}),
      };
    });

    // Queue depth as the ENGINE reports it, never counted here: a client-side
    // count would be a second opinion about the same number.
    //
    // The admission refusal has no field of its own in `queueHealth` — the pool
    // refuses a wake when `used + footprint` crosses the limit, and that is
    // observable only as a `degraded` cell with rounds that never leave
    // `queued`. So the refusal is reported as an EXPLICIT unknown rather than
    // guessed at: claiming "resource refused" from `degraded` would be a
    // diagnostic the engine never made.
    let queueDepth = null;
    let admissionRefusal = null;
    try {
      const health = engine.queueHealth?.({});
      queueDepth = Number.isFinite(health?.queued) ? health.queued : null;
      if (health?.degraded === true && queueDepth > 0) {
        admissionRefusal = {
          used: null,
          limit: null,
          message: "队列处于降级态（可能因资源准入被拒）——引擎未给出具体拒因",
        };
      }
    } catch {
      // A stats failure leaves the numbers null — "unknown", which the UI must
      // render as unknown. Filling in 0 here would be the exact defect the
      // agent-run-board spec keeps writing rules against.
    }

    res.json({ flows: flowDb().listFlows(), cards, queueDepth, admissionRefusal, unscoped });
  });

  router.get("/:flowId", (req, res) => {
    const flow = flowDb().getFlow(req.params.flowId);
    if (!flow) return res.status(404).json({ error: "flow_not_found", message: `未找到流程 ${req.params.flowId}` });
    res.json({ flow });
  });

  router.put("/:flowId", (req, res) => {
    const declaration = { ...(req.body ?? {}), flowId: req.params.flowId };
    // A declaration that half-writes is a declaration nobody can trust — the
    // validator runs BEFORE the store sees anything.
    const check = validateFlowDeclaration(declaration);
    if (!check.ok) {
      return res.status(400).json({ error: "flow_invalid", issues: check.errors });
    }
    const normalized = normalizeFlowDeclaration(declaration);
    res.json({ flow: flowDb().putFlow(normalized) });
  });

  router.delete("/:flowId", (req, res) => {
    const removed = flowDb().deleteFlow(req.params.flowId);
    if (!removed) return res.status(404).json({ error: "flow_not_found" });
    res.json({ ok: true });
  });

  // ── 5.1 create a card (never starts it) ───────────────────────────────────

  router.post("/:flowId/cards", (req, res) => {
    const flow = getFlow(req.params.flowId);
    if (!flow) return res.status(404).json({ error: "flow_not_found" });

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    if (!prompt.trim()) return res.status(400).json({ error: "prompt_required" });

    const stationId = req.body?.stationId ?? flow.stations?.[0]?.stationId;
    const station = stationOf(flow, stationId);
    if (!station) {
      return res.status(400).json({ error: "station_not_found", message: `流程 ${flow.flowId} 没有站点 ${stationId}` });
    }

    // Created as a SCHEDULE-shaped record with no schedule: the card exists and
    // is addressable, but nothing is enqueued. `createManualTask` enqueues on
    // creation, which is exactly wrong here — a card that runs the moment you
    // write it is the opposite of "arrange first, run when ready".
    const id = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let task;
    try {
      task = engine.insertTask({
        id,
        trigger: "manual",
        type: "manual",
        cron: null,
        when: null,
        prompt,
        preset: null,
        targetType: "persona",
        sessionId: `task-${id}`,
        sessionTitle: req.body?.title || null,
        status: "manual",
        paused: true,
        createdAt: new Date().toISOString(),
        lastRun: null,
        nextRun: null,
        flow: {
          ...stampAcceptance({ flowId: flow.flowId }, station),
          // Owner attribution for the inbox lane (task 7.1). The engine never
          // interprets this; the flow layer writes and reads it, and the lane
          // filters by it. Without it a shared-process deployment would show
          // one user's cards to another.
          owner: OWNER_OF(req, ctx),
        },
        origin: { flow: { flowId: flow.flowId } },
      });
    } catch (err) {
      return res.status(400).json({ error: "card_create_failed", message: err.message });
    }

    const blockedBy = Array.isArray(req.body?.blockedBy) ? req.body.blockedBy.filter((x) => typeof x === "string") : [];
    if (blockedBy.length) flowDb().addDeps(id, blockedBy);

    void engine.saveTasks();
    res.json({ card: engine.getTask(task.id) });
  });

  // ── 5.2 dispatch ──────────────────────────────────────────────────────────

  router.post("/cards/:taskId/dispatch", async (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });

    // Dependencies gate DISPATCH, not execution — and they gate it at exactly
    // this moment, once, rather than through a polling scheduler (design D7).
    const blockers = flowDb().blockersOf(record.id);
    const open = blockers.filter((b) => engine.getRecord(b)?.flow?.verdict?.outcome !== "pass");
    if (open.length) {
      return res.status(409).json({ error: "card_blocked", blockedBy: open });
    }

    const flowId = req.body?.flowId ?? record.flow?.flowId;
    const stationId = req.body?.stationId ?? record.flow?.stationId;
    const flow = flowId ? getFlow(flowId) : null;
    if (!flow) return res.status(400).json({ error: "flow_not_found", message: `流程 ${flowId} 不存在` });
    const station = stationOf(flow, stationId);
    if (!station) return res.status(400).json({ error: "station_not_found", message: `站点 ${stationId} 不存在` });

    const resolved = resolveStationTarget(station, { exists });
    if (!resolved.ok) {
      // No default target. A vacant post is vacant (spec: task-flow).
      return res.status(409).json({ error: "station_unresolved", message: resolved.reason });
    }

    // Re-stake on every dispatch: the criteria in force are the ones this
    // station declared, and a re-dispatch to a new station must not inherit the
    // previous station's.
    const flowField = {
      ...stampAcceptance({ ...(record.flow ?? {}), flowId: flow.flowId }, station),
      dispatchedAt: new Date().toISOString(),
    };
    const target = resolved.target;
    // In-place retarget, the same rewrite fleet-reconcile does for carrier
    // changes: id, session and history stay put.
    record.preset = target.ref;
    record.targetType = target.personaBacked ? "persona" : target.kind;
    engine.setTaskFlow(record.id, flowField);
    record.paused = false;
    record.status = "manual";

    const enq = engine.runTaskNow(record.id);
    void engine.saveTasks();
    const result = await Promise.resolve(enq);
    if (result && result.ok === false) {
      return res.status(409).json({ error: "dispatch_refused", message: result.error ?? "enqueue refused" });
    }
    res.json({ card: engine.getTask(record.id) });
  });

  // ── 5.3 accept ────────────────────────────────────────────────────────────

  router.post("/cards/:taskId/accept", async (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });

    const flowField = record.flow ?? {};
    const evidence = evidenceFromExecution({
      history: record.history ?? [],
      artifacts: req.body?.artifacts ?? [],
      facts: req.body?.facts ?? {},
    });
    const result = evaluateAcceptance(flowField.acceptance ?? [], evidence, { judge });

    const override = req.body?.override;
    const wantsOverride = override && typeof override.reason === "string" && override.reason.trim() !== "";

    if (result.outcome !== "pass" && !wantsOverride) {
      // The hard gate. "no-criteria" lands here too — a station that declared
      // nothing requires a human signature, it does not auto-pass.
      return res.status(409).json({
        error: result.outcome === "no-criteria" ? "no_criteria" : "criteria_failed",
        evaluation: result,
        message:
          result.outcome === "no-criteria"
            ? "该站点未声明验收判据，需人工签收（可带 override.reason 越过）"
            : "验收判据未通过",
      });
    }

    const verdict = {
      outcome: "pass",
      // Three outcomes must remain distinguishable after the fact: an automatic
      // pass, a human override, and (below) a return. Collapsing them is what
      // makes "done" unfalsifiable again.
      by: wantsOverride ? "override" : "criteria",
      reason: wantsOverride ? override.reason : null,
      actor: ACTOR_OF(req),
      at: new Date().toISOString(),
      evaluation: result,
    };
    engine.setTaskFlow(record.id, { ...flowField, verdict });
    void engine.saveTasks();
    res.json({ card: engine.getTask(record.id) });
  });

  // ── 5.4 return ────────────────────────────────────────────────────────────

  router.post("/cards/:taskId/return", async (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ error: "reason_required", message: "退卡必须写明理由" });

    const flowField = record.flow ?? {};
    const flow = flowField.flowId ? getFlow(flowField.flowId) : null;
    const index = (flow?.stations ?? []).findIndex((s) => s.stationId === flowField.stationId);
    // Back one station; at the first station, back to the un-started state
    // (no station, no criteria) — which is "待安排", not a silent replay.
    const prev = index > 0 ? flow.stations[index - 1] : null;

    const from = { flowId: flowField.flowId ?? null, stationId: flowField.stationId ?? null };
    const to = prev ? { flowId: flow.flowId, stationId: prev.stationId } : { flowId: flowField.flowId ?? null, stationId: null };

    const next = prev
      ? stampAcceptance({ ...flowField, verdict: { outcome: "returned", reason, actor: ACTOR_OF(req), at: new Date().toISOString() } }, prev)
      : { flowId: flowField.flowId ?? null, stationId: null, acceptance: [], stakedAt: flowField.stakedAt ?? null, verdict: { outcome: "returned", reason, actor: ACTOR_OF(req), at: new Date().toISOString() } };

    engine.setTaskFlow(record.id, next);
    flowDb().recordReassignment({ taskId: record.id, from, to, actor: ACTOR_OF(req), reason });
    void engine.saveTasks();
    res.json({ card: engine.getTask(record.id) });
  });

  // ── 5.6 the card's execution transcript (make-task-flow-board-live 5.1) ───

  // The conversation a card produced, read-only.
  //
  // Why this endpoint exists instead of pointing the drawer at
  // `/api/chat-history/sessions/task-<id>`: task sessions are written by the
  // cron runner WITHOUT an owner, and `chatHistory.accessSession` only admits a
  // NULL-owner row to an admin — so under auth the card's OWN owner would get a
  // 403 from the natural-looking path. Authorization here is the card's, which
  // is the question the reader is actually asking ("may I see this card?").
  //
  // Partial failure is a first-class outcome: an unreadable transcript must not
  // take the card down with it, so the route answers 200 with `readError` rather
  // than a 5xx.
  router.get("/cards/:taskId/transcript", async (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });

    const viewer = boardViewerOf(req, ctx);
    if (!viewer.includeAll && (record.flow?.owner ?? null) !== viewer.email) {
      // Same shape as a missing card: "exists but not yours" is not something
      // this reader needs to learn.
      return res.status(404).json({ error: "card_not_found" });
    }

    const sessionId = record.sessionId ?? null;
    if (!sessionId) {
      return res.json({ sessionId: null, exists: false, messages: [] });
    }
    const history = deps.chatHistory ?? ctx.chatHistory ?? null;
    if (!history) {
      return res.json({ sessionId, exists: false, messages: [], readError: "会话读取面在此部署不可用" });
    }
    try {
      const sess = await history.getSession(sessionId);
      if (!sess) return res.json({ sessionId, exists: false, messages: [] });
      const messages = (sess.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
      return res.json({ sessionId, exists: messages.length > 0, messages });
    } catch (err) {
      return res.json({ sessionId, exists: false, messages: [], readError: err?.message || String(err) });
    }
  });

  // ── 5.5 dependencies ──────────────────────────────────────────────────────

  router.post("/cards/:taskId/deps", (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });
    const ids = Array.isArray(req.body?.blockedBy) ? req.body.blockedBy.filter((x) => typeof x === "string") : null;
    if (!ids) return res.status(400).json({ error: "blockedBy_required" });
    flowDb().clearDeps(record.id);
    res.json({ blockedBy: flowDb().addDeps(record.id, ids) });
  });

  router.delete("/cards/:taskId/deps", (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });
    flowDb().clearDeps(record.id);
    res.json({ blockedBy: [] });
  });

  // Reassignment (team takeover) — the fifth route but the same in-place
  // rewrite; it is not a fifth VERB because it changes where a card lives, not
  // whether it runs.
  router.post("/cards/:taskId/reassign", (req, res) => {
    const record = engine.getRecord(req.params.taskId);
    if (!record) return res.status(404).json({ error: "card_not_found" });
    const flowId = req.body?.flowId ?? record.flow?.flowId;
    const flow = flowId ? getFlow(flowId) : null;
    if (!flow) return res.status(404).json({ error: "flow_not_found" });
    const station = stationOf(flow, req.body?.stationId);
    if (!station) return res.status(400).json({ error: "station_not_found" });

    const result = reassignCard({
      current: { ...(record.flow ?? {}), flowId: flow.flowId },
      station,
      resolve: (s) => resolveStationTarget(s, { exists }),
    });
    if (!result.ok) return res.status(409).json({ error: "reassign_refused", message: result.reason });

    const from = { flowId: record.flow?.flowId ?? null, stationId: record.flow?.stationId ?? null };
    engine.setTaskFlow(record.id, result.flow);
    flowDb().recordReassignment({ taskId: record.id, from, to: { flowId: flow.flowId, stationId: station.stationId }, actor: ACTOR_OF(req), reason: req.body?.reason ?? null });
    void engine.saveTasks();
    res.json({ card: engine.getTask(record.id) });
  });

  app.use("/api/flows", router);
}
