// Handoff + fanout ignition seam (agent-fleet-orchestration D4, add-fleet-fanout D2).
//
// Extracted from server.js's ctx wiring so the REAL function is importable by
// tests — the pre-extraction fanout tests mirrored the logic in their own
// stubs and self-consistently missed the `if (!edges.length) return null`
// early return that made every fanout-only source dead (挂账取证班 2026-10-31
// 真缺陷: the fanout loop sat after the early return, so a member whose only
// outgoing edges are fanouts never ignited them; fanout fleets that also
// handed off were the only working shape). The early return is gone — the
// handoff loop no-ops on an empty list and the fanout loop always runs.
//
// Upstream completion — ok or failed, both honestly relayed — creates one
// manual turn per declared outgoing edge, depth read from the chain position
// in origin.fleet. Over-bound hops create nothing but leave an honest event
// row. Cluster posts have no manual lane: skipped, their next
// cadence/delegation turn carries the work.

import { outgoingHandoffs, outgoingFanouts, constraintsOf } from "./fleet-orchestration.js";
import { derivedLaneCarrier } from "./fleet-events.js";

// ── Ignition identity (add-fleet-ignition-idem) ────────────────────────────
//
// Every hop an ignition creates is stamped with a key made of the UPSTREAM
// TURN's identity, the edge kind and the target post. Re-entering the seam for
// a turn that already ignited (a retried execution, a second finish callback,
// a resumed round) must not create a second wave downstream — the same work
// would run twice and the fleet would pay for it twice.
//
// The turn's identity: the run ledger's turnId when the ledger exists (that is
// the value the rest of the platform attributes the run by), else the engine's
// per-execution sequence. A DELIBERATE re-run of a post is a NEW turn with a
// new id and ignites again on purpose — otherwise an operator could never
// re-drive a broken chain; dedupe is per turn, not per post.
export function ignitionTurnKey(job, ledgerTurn) {
  if (ledgerTurn?.turnId) return ledgerTurn.turnId;
  const seq = Number.isFinite(job?.roundSeq) ? job.roundSeq : 0;
  return `${job?.id ?? "job"}:r${seq}`;
}

// Keys already fired, read back from the tasks themselves: every ignited task
// carries `origin.fleet.ignition`, and records persist — so this needs no new
// store and survives a restart. (A hop whose task was deleted can re-fire; the
// work is gone then anyway.)
function firedIgnitionKeys(engine) {
  const keys = new Set();
  try {
    for (const t of engine.allRecords?.() ?? []) {
      const key = t?.origin?.fleet?.ignition;
      if (typeof key === "string" && key) keys.add(key);
    }
  } catch { /* an unreadable store means no dedupe — never a failed ignition */ }
  return keys;
}

// ── Run-level admission (add-fleet-run-budget) ──────────────────────────────
//
// A per-edge timeout bounds one hop; nothing bounded the chain. Before any hop
// is created, ask the run header: was this run stopped, and is it already over
// its declared ceiling? "Stopped" covers both an owner cancel and a budget stop
// (the first writer's reason wins), so this one check closes both doors.
//
// Counting: finished turns come from the turn rows (the same source finalizeRun
// trusts); in-flight turns of the run are added because a wave starts several
// hops at once and would otherwise each see the same pre-wave count.
//
// Returns null when clear, else a structured reason. PURE — no writes.
export function runAdmissionBlocked(db, engine, runId, budget, { now = Date.now() } = {}) {
  if (!runId) return null;
  const usage = db.runUsage?.(runId) ?? null;
  if (!usage) return null; // unknown run (legacy row) — never block on a missing header
  if (usage.stoppedAt != null) {
    return {
      code: "run_stopped",
      reason: usage.stopReason || "run stopped",
    };
  }
  if (!budget) return null;
  const inflight = (engine?.allRecords?.() ?? []).filter(
    (t) => t?.origin?.fleet?.chain?.runId === runId && (t.state === "queued" || t.state === "running"),
  ).length;
  const turnsSoFar = usage.turns + inflight;
  if (budget.maxTurns != null && turnsSoFar >= budget.maxTurns) {
    return { code: "run_budget", reason: `run turn budget reached (${turnsSoFar}/${budget.maxTurns})` };
  }
  if (budget.maxTokens != null && usage.tokens >= budget.maxTokens) {
    return { code: "run_budget", reason: `run token budget reached (${usage.tokens}/${budget.maxTokens})` };
  }
  if (budget.maxMinutes != null && Number.isFinite(usage.startedAt)) {
    const minutes = (now - usage.startedAt) / 60_000;
    if (minutes >= budget.maxMinutes) {
      return { code: "run_budget", reason: `run time budget reached (${Math.floor(minutes)}/${budget.maxMinutes} min)` };
    }
  }
  return null;
}

// ── Upstream artifacts (add-fleet-artifact-handoff) ─────────────────────────
//
// A handoff used to relay PROSE only: the downstream post read a 2000-char
// summary and, if it needed the actual chart/doc/sheet the upstream produced,
// had to regenerate it from scratch — paying twice and often landing on a
// different artifact. The platform already captures turn-produced files into
// the resource library (`resources.captureFilesFromTurn`), so the handles exist;
// they just never crossed the edge.
//
// Handles are addressed by the library id (stable, server-side) plus the
// workspace-relative path (usable by a resident persona that shares the cwd).
// Persona targets only: an a2a target is another service — a library id means
// nothing there — and a tool target's prompt must stay pure JSON args.
//
// Degrade open: no db handle, a missing resources table, or a refused read all
// yield no section (the edge still ignites with the prose it always had).
async function upstreamArtifactSection(sessionId, { sinceMs = null, limit = 8 } = {}) {
  if (!sessionId) return "";
  let rows = [];
  try {
    const mod = await import("../resources.js");
    rows = (await mod.artifactsForSession({ sessionId, sinceMs, limit })) ?? [];
  } catch {
    return ""; // a resources hiccup never blocks the handoff
  }
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const where = r.filePath ? ` · workspace: ${r.filePath}` : "";
    return `- 资源库 ${r.id}「${r.title}」${where}`;
  });
  return (
    "【上游产物】上游回合产出了以下可寻址产物——直接用它们，不要重新生成：" +
    "\n" + lines.join("\n")
  );
}

export async function igniteFleetEdges({ db, engine, job, out, ledgerTurn = null, rosterPresetId = (id) => id, chainFor = () => null }) {
  const withChain = (fleet, edgeKind) => {
    const chain = chainFor(edgeKind);
    return chain ? { ...fleet, chain } : fleet;
  };
  let fleetId = null;
  let memberId = null;
  let chainDepth = 0;
  if (job?.origin?.fleet?.fleetId) {
    fleetId = job.origin.fleet.fleetId;
    memberId = job.origin.fleet.memberId ?? null;
    chainDepth = Number.isFinite(job.origin.fleet.depth) ? job.origin.fleet.depth : 0;
  } else if (job?.sourceTag?.fleetId) {
    fleetId = job.sourceTag.fleetId;
    memberId = job.sourceTag.memberId ?? null;
  }
  if (!fleetId || !memberId) return null;
  const fleet = db.getFleet(fleetId);
  if (!fleet?.orchestration) return null;
  const edges = outgoingHandoffs(fleet.orchestration, memberId);
  // No early return here (see header): fanout-only sources must reach the
  // fanout loop below.
  const constraints = constraintsOf(fleet.orchestration);
  const nextDepth = chainDepth + 1;
  const now = Date.now();
  const dispatched = [];
  // The upstream turn's artifacts ride the ignition (add-fleet-artifact-handoff):
  // captured under the upstream's mirror session, bounded to this turn's window.
  const artifactSection = await upstreamArtifactSection(job?.sessionId ?? null, {
    sinceMs: ledgerTurn?.startedAt ?? null,
  });
  const turnKey = ignitionTurnKey(job, ledgerTurn);
  const fired = firedIgnitionKeys(engine);
  const hopKey = (edgeKind, targetId) => `${turnKey}:${edgeKind}:${targetId}`;
  // The run this ignition belongs to, and its admission verdict (see
  // runAdmissionBlocked). A blocked run creates no hops at all — and a budget
  // stop is recorded ONCE, by the first hop that finds it, not per target.
  const runId = ledgerTurn?.runId ?? job?.origin?.fleet?.chain?.runId ?? null;
  const blocked = runAdmissionBlocked(db, engine, runId, constraints.runBudget, { now });
  if (blocked) {
    if (blocked.code === "run_budget") {
      // Persist the ceiling as the run's stop reason so the read face and the
      // next ignition agree without re-deriving the numbers.
      try {
        db.stopRun?.(runId, { reason: `budget: ${blocked.reason}`, at: now });
      } catch { /* a failed stamp must not make the block disappear */ }
    }
    // One honest row per would-be wave: the fleet sees WHY nothing was ignited.
    db.appendTurnEvent({
      fleetId,
      memberId,
      source: "manual",
      status: "failed",
      errorKind: "other",
      error: `edge ignition refused: ${blocked.reason}`,
      startedAt: now,
      endedAt: now,
      sessionId: null,
      // The refusal belongs to the upstream post's lane — derive it from the
      // real member row, not from a guess.
      metering: { carrier: derivedLaneCarrier({ member: db.getMember(memberId), fleet, targetKind: "persona" }) },
    });
    return null;
  }
  for (const e of edges) {
    const target = db.getMember(e.to);
    if (!target || target.fleetId !== fleetId) continue;
    if (target.targetKind === "cluster") continue;
    if (nextDepth > constraints.maxChainDepth) {
      db.appendTurnEvent({
        fleetId,
        memberId: target.id,
        source: "manual",
        status: "failed",
        errorKind: "other",
        error: `handoff depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — chain stopped before this hop`,
        startedAt: now,
        endedAt: now,
        sessionId: null,
        // Derived-lane marking (add-turn-metering挂账): the turn never
        // dispatched — the row carries the lane it BELONGS to.
        metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
      });
      continue;
    }
    // Tool hops are deterministic: the edge carries their JSON args (edge.
    // args); prose summaries are not executable arguments and fail honestly.
    if (target.targetKind === "tool") {
      const argsOk = e.args != null && typeof e.args === "object" && !Array.isArray(e.args);
      if (!argsOk) {
        db.appendTurnEvent({
          fleetId,
          memberId: target.id,
          source: "manual",
          status: "failed",
          errorKind: "runtime_not_ready",
          error: "handoff to a tool post needs the edge's `args` (JSON object) — upstream prose is not executable",
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Tool targets carry no lane (consistent with executed tool turns).
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const hk = hopKey("handoff", target.id);
      if (fired.has(hk)) continue;
      fired.add(hk);
      const task = engine.createManualTask({
        prompt: JSON.stringify(e.args),
        tool: target.targetId,
        sessionTitle: `接棒 · ${target.title}`,
        origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth, ignition: hk, byMemberId: memberId }, "handoff") },
        executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
      });
      dispatched.push({ to: target.id, taskId: task.id });
      continue;
    }
    const summary = out?.ok === true
      ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
      : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
    const hk = hopKey("handoff", target.id);
    if (fired.has(hk)) continue;
    fired.add(hk);
    const task = engine.createManualTask({
      prompt:
        `【舰队接棒】上游岗位回合结束,依声明边接棒(链位 ${nextDepth}/${constraints.maxChainDepth})。\n` +
        `上游结果:\n${summary}` +
        // add-fleet-artifact-handoff: the upstream's artifacts as ADDRESSABLE
        // handles (library id + workspace path), so the successor reuses them
        // instead of regenerating. Persona only, and absent when the upstream
        // produced none.
        // persona-only: 编导边的目标；审计官不进工作图（orchestration 已显式拒绝）
        (target.targetKind === "persona" && artifactSection ? `\n\n${artifactSection}` : "") +
        // add-fleet-edge-context D1: the fleet view rides along, rendered at the
        // engine's one injection seam. Persona only — an a2a target is another
        // service, and a tool target's prompt IS its JSON arguments.
        // persona-only: 同上——边上下文只注入给边目标
        (target.targetKind === "persona" ? "\n\n{{fleetEdgeContext}}" : ""),
      ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
      sessionTitle: `接棒 · ${target.title}`,
      origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth, ignition: hk, byMemberId: memberId }, "handoff") },
      executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
    });
    dispatched.push({ to: target.id, taskId: task.id });
  }

  // Fanout edges (add-fleet-fanout D2): one parallel wave per edge — a
  // manual turn per target, same honest relay as handoff, depth rides the
  // chain. Aggregation rides the delegation aggregator VERBATIM: no-judge
  // waves carry the upstream session as initiator (the group's outcomes
  // inject into the upstream post's next turn); judge waves carry the
  // synthetic fleet-scoped initiator + the judge's roster preset, so the
  // aggregator switches to the judge persona and runs the ruling turn on
  // group completion. Wave counter is provenance only (single wave per
  // upstream turn; further debate rounds are the judge's own dispatch_post
  // calls, depth is the hard bound).
  //
  // fix-fanout-aggregation: (D1) the no-judge branch used to pass no
  // initiatorPreset, so the aggregator's persona re-anchor was a no-op and the
  // summary was spoken by whatever the runtime last composed (the last fan-out
  // target). (D2) every ignition now stamps its own group key — grouping by
  // initiator alone merged a second wave into the first wave's summary.
  const fanouts = outgoingFanouts(fleet.orchestration, memberId);
  for (const e of fanouts) {
    const agg = e.aggregate ?? { kind: "all" };
    const judge = agg.kind === "judge" ? db.getMember(agg.judge) : null;
    // persona-only: fanout 裁判；审计官不得当裁判（它只出异议，不出结论）
    if (agg.kind === "judge" && (!judge || judge.fleetId !== fleetId || judge.targetKind !== "persona")) continue;
    const summary = out?.ok === true
      ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
      : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
    const rounds = Number.isInteger(e.rounds) ? e.rounds : 1;
    // One key per (edge, ignition): unique by construction, survives restarts
    // because it is persisted on the tasks.
    const groupKey = `fanout:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    for (const t of e.targets ?? []) {
      const target = db.getMember(t);
      if (!target || target.fleetId !== fleetId) continue;
      if (target.targetKind === "cluster" || target.targetKind === "tool") continue;
      if (nextDepth > constraints.maxChainDepth) {
        db.appendTurnEvent({
          fleetId,
          memberId: target.id,
          source: "manual",
          status: "failed",
          errorKind: "other",
          error: `fanout depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — wave stopped before this hop`,
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Derived-lane marking (add-turn-metering挂账): the turn never
          // dispatched — the row carries the lane it BELONGS to.
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const hk = hopKey("fanout", target.id);
      if (fired.has(hk)) continue;
      fired.add(hk);
      const task = engine.createManualTask({
        prompt:
          `【舰队并行扇出】上游岗位「${db.getMember(memberId)?.title ?? memberId}」回合结束,你与同波同伴并行接令(轮次 1/${rounds})。\n` +
          `上游结果:\n${summary}` +
          // add-fleet-artifact-handoff: same handles, same reason as handoff.
          // persona-only: 编导边的目标；审计官不进工作图
          (target.targetKind === "persona" && artifactSection ? `\n\n${artifactSection}` : "") +
          // add-fleet-edge-context D1: same seam, same reason as handoff.
          // persona-only: 同上
          (target.targetKind === "persona" ? "\n\n{{fleetEdgeContext}}" : ""),
        ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `扇出 · ${target.title}`,
        origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth, wave: 1, ignition: hk, byMemberId: memberId }, "fanout") },
        initiatorGroup: groupKey,
        ...(judge
          ? { initiator: `fleet:${fleetId}:${judge.id}`, initiatorPreset: rosterPresetId(judge.targetId) }
          : { initiator: job.sessionId ?? null, initiatorPreset: job.preset ?? null }),
        executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
      });
      dispatched.push({ to: target.id, taskId: task.id, wave: true, judge: judge?.id ?? null });
    }
  }
  return dispatched.length ? dispatched : null;
}
