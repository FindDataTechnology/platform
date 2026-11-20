// Run ledger (agent-fleet-runs, add-fleet-cockpit-v2).
//
// The execution instance behind the cockpit's live canvas and replay
// timeline. One ledger per cell, held on ctx as `fleetTurnLedger`:
//
//   begin(job)  — at the turn-seam's START: resolves the post (same rule as
//                 the outcome recorder), mints the turn id and — for a root
//                 turn — the run id; a downstream turn (dispatch / handoff /
//                 fanout) inherits its run from the chain the igniting side
//                 stamped on the task. Opens / re-opens the run header,
//                 registers the in-flight turn (by turn id, by session ids,
//                 by post) and broadcasts fleet_turn_started.
//   end(…)      — at the seam's END: writes the outcome row through
//                 recordTurnEvent (one shaping, one attribution), unregisters,
//                 broadcasts fleet_turn_ended.
//   settle(run) — after the seam has queued its handoffs: closes the header
//                 iff nothing of that run is still open or queued. The header
//                 is a projection recomputed from the rows (SUM), so a late
//                 downstream turn can re-open and re-close it idempotently.
//   tap(…)      — the collector's hook: fleet turns never cross
//                 handleDshEvent, so their runtime events reach the trace
//                 store from here, keyed by the ledger's turn id.
//
// Why ids at START (design D2): a dispatch_post call happens MID-turn and
// must stamp the upstream turn id on the task it creates; the outcome row
// does not exist yet. Everything degrades open — a ledger failure is a warn,
// never a failed turn (the seam wraps every call).

import { randomUUID } from "node:crypto";
import { buildTurnRequest, assertTurnRequest } from "./turn-request.js";
import { constraintsOf } from "./fleet-orchestration.js";
import { resolveTurnPost, recordTurnEvent } from "./fleet-events.js";
import { cellSourceFor, turnRefFor } from "../lib/turn-claim.js";

export function mintId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// FLEET_TRACE_TAP=0 turns the collector tap off (a cell that would rather not
// double its trace.db); default on.
export function traceTapEnabled() {
  return process.env.FLEET_TRACE_TAP !== "0";
}

// Wire shape of the three fleet events — fleet-domain fields only: ids,
// outcome, timing. Never a credential, never a session body. parentMemberId
// resolves the chain's parent turn to its POST so the canvas can light the
// igniting edge (dispatch mid-turn reads the open registry; handoff reads the
// ended parent's row).
function turnWire(handle, extra = {}) {
  return {
    fleetId: handle.fleetId,
    memberId: handle.memberId,
    runId: handle.runId,
    turnId: handle.turnId,
    parentTurnId: handle.parentTurnId,
    parentMemberId: handle.parentMemberId,
    edgeKind: handle.edgeKind,
    source: handle.source,
    sessionId: handle.sessionId,
    startedAt: handle.startedAt,
    ...extra,
  };
}

export function createFleetTurnLedger({
  db,
  claims = null,
  fingerprintFor = null,
  broadcast = () => {},
  engineRecords = () => [],
  trace = null,
  rosterPresetId = (id) => id,
  now = Date.now,
  onInterruptedRun = null,
} = {}) {
  const open = new Map(); // turnId → handle
  const bySession = new Map(); // sessionId → turnId
  // turnToken → turnId（attribute-turn-by-session）。为什么需要这张表：worker 车道上
  // 没有成员私有 patch（home 按 pack 共享、N 个成员跨舰队），header/env 两条身份通道
  // 都不可用，于是并发时只剩「唯一在飞回合」可判 ⇒ 结构性 409。令牌由服务端起回合时
  // 生成、随该轮身份行只送到该轮运行时，强度与 header 同级，且与 carrier 无关。
  const byToken = new Map();
  const byMember = new Map(); // memberId → turnId[] (oldest first)

  // ── claim lane (harden-agent-runtime-spine, agent-turn-claim) ─────────────
  //
  // The claim is written HERE and nowhere else: all three execution paths
  // (cron serial, worker pool, delegation ruling) reach the ledger through
  // `begin`, so this is the one write point. A claim failure fails the turn
  // (spec: 认领未落库 ⇒ 明确失败) instead of letting an unrecorded attempt run —
  // an execution with no claim is indistinguishable, afterwards, from one that
  // never happened.
  //
  // The carrier source reuses the SAME 16-hex derivation the gateway uses for
  // /data/cells/<hex>, so a claim and the cell export name the same cell.
  const carrierSource = (() => {
    const single = String(process.env.SINGLE_TENANT || "") === "1";
    const email = process.env.CELL_USER_EMAIL || "";
    try {
      return cellSourceFor({ email, single });
    } catch {
      return cellSourceFor({ email: null, single: true });
    }
  })();

  function claimRefFor(handle) {
    return turnRefFor({ driver: "platform", source: carrierSource, runId: handle.runId, turnId: handle.turnId });
  }

  function openClaim(handle, { startedAt, fingerprint = null, fingerprintParts = null } = {}) {
    if (!claims) return { ok: true, skipped: "no-claim-store" };
    const turnRef = claimRefFor(handle);
    if (!turnRef) return { ok: false, reason: "address-build-failed" };
    const out = claims.claim({
      turnRef,
      driver: "platform",
      source: carrierSource,
      runId: handle.runId,
      turnId: handle.turnId,
      fleetId: handle.fleetId,
      memberId: handle.memberId,
      sessionId: handle.sessionId,
      startedAt,
      runtimeFingerprint: fingerprint,
      runtimeFingerprintParts: fingerprintParts,
    });
    if (out?.ok) handle.claimRef = turnRef;
    return out;
  }

  function closeClaim(handle, { reason, at = now(), cancelledBy = null } = {}) {
    if (!claims || !handle?.claimRef) return null;
    try {
      return claims.close(handle.claimRef, { reason, at, cancelledBy });
    } catch (e) {
      console.warn(`[fleet-runs] claim close failed for ${handle.turnId}: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * The cell's own configuration identity, computed lazily ONCE per process
   * (the composed patches and skills roots do not change mid-run; a roster
   * refresh rewrites them and restarts the child). Injected by `server.js` as
   * `fingerprintFor` so this module keeps no filesystem knowledge of its own.
   *
   * Absent injector ⇒ `null`, and the claim records "no fingerprint" — which is
   * a stated value, not a guess.
   */
  let cachedFingerprint;
  function cellFingerprintFor(presetId) {
    if (typeof fingerprintFor !== "function") return null;
    if (cachedFingerprint !== undefined && cachedFingerprint?.presetId === presetId) return cachedFingerprint;
    try {
      const fp = fingerprintFor({ presetId }) ?? null;
      cachedFingerprint = fp ? { ...fp, presetId } : null;
      return fp;
    } catch (e) {
      console.warn(`[fleet-runs] fingerprint unavailable for ${presetId ?? "(no preset)"}: ${e?.message || e}`);
      return null;
    }
  }

  function claimFingerprintMissing(handle) {
    if (!claims || !handle?.claimRef) return false;
    try {
      return !claims.get(handle.claimRef)?.runtime_fingerprint;
    } catch {
      return false;
    }
  }

  /**
   * The outcome → terminal reason map. ONE function, so the closed vocabulary
   * (spec: 终态是封闭词表) holds for every path: a `skipped` round produced no
   * attempt and closes nothing; a hollow `ok` is already `interrupted` by
   * `shapeTurnOutcome`, so we read the row's verdict instead of re-deriving it.
   */
  function reasonFor(event, outcome) {
    if (event) {
      if (event.status === "ok") return "ok";
      if (event.status === "interrupted") return "interrupted";
      if (event.status === "skipped") return null; // no attempt ⇒ nothing to close
      return "failed";
    }
    if (outcome?.interrupted === true) return "interrupted";
    return outcome?.ok === true ? "ok" : "failed";
  }

  function emit(type, payload) {
    try {
      broadcast({ type, ...payload });
    } catch (e) {
      console.warn(`[fleet-runs] broadcast ${type} failed: ${e?.message || e}`);
    }
  }

  function register(handle) {
    open.set(handle.turnId, handle);
    for (const s of handle.sessionIds) bySession.set(s, handle.turnId);
    if (handle.turnToken) byToken.set(handle.turnToken, handle.turnId);
    byMember.set(handle.memberId, [...(byMember.get(handle.memberId) ?? []), handle.turnId]);
  }

  function unregister(handle) {
    open.delete(handle.turnId);
    for (const s of handle.sessionIds) {
      if (bySession.get(s) === handle.turnId) bySession.delete(s);
    }
    // 令牌随回合结束失效：留着它等于给一个已收尾的回合留后门。
    if (handle.turnToken && byToken.get(handle.turnToken) === handle.turnId) byToken.delete(handle.turnToken);
    const stack = (byMember.get(handle.memberId) ?? []).filter((t) => t !== handle.turnId);
    if (stack.length) byMember.set(handle.memberId, stack);
    else byMember.delete(handle.memberId);
  }

  // `sessionIds`: every id this turn's runtime events may arrive under — the
  // stable mirror session and, for fleet rounds, the rotated child id.
  function begin(job, { startedAt = now(), sessionIds = [], fingerprint = null, fingerprintParts = null } = {}) {
    const request = buildTurnRequest(job);
    const post = resolveTurnPost(db, request, rosterPresetId);
    if (!post?.fleetId || !post?.memberId) return null;

    const chain = request.chain;
    const runId = chain?.runId ?? mintId("run");
    const turnId = mintId("turn");
    if (!chain) {
      db.insertRun({ runId, fleetId: post.fleetId, rootSource: request.source, rootMemberId: post.memberId, startedAt });
    } else {
      const header = db.getRun(runId);
      if (!header) {
        // The root's header is gone (pruned, or the chain crossed a cell
        // restart that lost it): keep the chain honest under its own id
        // rather than inventing a new run.
        db.insertRun({ runId, fleetId: post.fleetId, rootSource: request.source, rootMemberId: post.memberId, startedAt });
      } else if (header.status !== "open") {
        db.reopenRun(runId);
      }
    }

    const mirror = job?.sessionId ?? null;
    // The chain's parent post, for edge lighting on the canvas. Dispatch
    // happens while the parent turn is still open (registry hit); a handoff
    // fires after it ended (row hit). Neither found (pruned / cross-restart)
    // → null, and the client lights only the node.
    const parentMemberId = chain?.parentTurnId
      ? open.get(chain.parentTurnId)?.memberId ?? db.getTurnEvent(chain.parentTurnId)?.memberId ?? null
      : null;
    const handle = {
      turnId,
      runId,
      // 逐轮随机、不可猜；只在内存里，随回合结束清除。
      turnToken: mintId("tk"),
      fleetId: post.fleetId,
      memberId: post.memberId,
      source: request.source,
      parentTurnId: chain?.parentTurnId ?? null,
      parentMemberId,
      edgeKind: chain?.edgeKind ?? null,
      startedAt,
      sessionId: mirror,
      sessionIds: [...new Set([mirror, ...sessionIds].filter(Boolean))],
      traceTurnId: trace && traceTapEnabled() ? turnId : null,
    };
    register(handle);
    if (handle.traceTurnId) {
      try {
        trace.bindTurn?.(turnId);
      } catch { /* best-effort */ }
    }
    // claim BEFORE the broadcast and before the caller can prompt: from here on
    // the attempt exists on disk, whatever happens to this process.
    // `fingerprint`/`fingerprintParts` ride in on meta when the caller computed
    // one (the compose seam); absent = the attempt carries no fingerprint, and
    // the read face says so instead of guessing.
    const claimed = openClaim(handle, {
      startedAt: handle.startedAt,
      fingerprint,
      fingerprintParts,
    });
    // No fingerprint from the caller (the runner-side compose path supplies
    // one; the cell-side lanes do not): compute the CELL's own from its
    // composed patches. Deferred to here rather than computed per-request so a
    // busy cell reads the tree once, and a failure records "no fingerprint"
    // instead of taking the turn down.
    if (claimFingerprintMissing(handle)) {
      const fp = cellFingerprintFor(job?.preset ?? null);
      if (fp?.bundle) claims?.setFingerprint(handle.claimRef, fp.bundle, fp.parts);
    }
    if (claimed && claimed.ok === false) {
      // A claim that cannot be written fails the attempt loudly (spec). Undo
      // the in-memory registration so no lane can pick this handle up, and tell
      // the caller — never execute an attempt with no claim.
      unregister(handle);
      throw Object.assign(new Error(`claim not recorded: ${claimed.reason || claimed.error || "unknown"}`), {
        code: "TURN_CLAIM_FAILED",
        claimFailure: claimed,
      });
    }
    // The handle carries the fingerprint so the RESULT row (written at end)
    // records the same identity the claim did — one value, two rows, per
    // spec 3.3. Read back from the claim so a caller-supplied fingerprint and
    // a computed one land identically.
    handle.runtimeFingerprint = claims?.get?.(handle.claimRef)?.runtime_fingerprint ?? null;
    emit("fleet_run_updated", { run: db.getRun(runId) });
    emit("fleet_turn_started", turnWire(handle));
    return handle;
  }

  function end(job, handle, outcome, meta = {}) {
    if (!handle) return null;
    // fix-fleet-model-drift: the trace carries the model the CHILD actually
    // emitted on its request header; when it disagrees with what the turn
    // thought it landed, stamp the mismatch into the row instead of trusting
    // the accounting side (the child's selection can drift out-of-band).
    if (trace && handle?.traceTurnId && meta?.model != null && outcome?.detail?.modelMismatch == null) {
      try {
        const turns = trace.getTurn(handle.traceTurnId);
        const headerEvent = turns?.find((t) => t.eventType === "request/header");
        const observed = headerEvent?.payload?.event?.data?.header?.config?.model ?? null;
        if (observed && observed !== meta.model) {
          outcome = {
            ...outcome,
            detail: {
              ...(outcome?.detail ?? {}),
              modelMismatch: { declared: meta.model, observedHeader: observed },
            },
          };
        }
      } catch { /* never fail the seam on the observation */ }
    }
    let event = null;
    try {
      event = recordTurnEvent(db, job, outcome, { ...meta, rosterPresetId, ledgerTurn: handle });
    } finally {
      unregister(handle);
    }
    // Close the claim with the row's own verdict. `skipped` closes nothing (no
    // attempt existed). The write is one-way, so a sweeper that already closed
    // this attempt as lease_expired wins — and the row still records what the
    // execution believed.
    const reason = reasonFor(event, outcome);
    if (reason) closeClaim(handle, { reason, at: event?.endedAt ?? meta?.endedAt ?? now() });
    emit(
      "fleet_turn_ended",
      turnWire(handle, {
        endedAt: event?.endedAt ?? meta.endedAt ?? now(),
        status: event?.status ?? null,
        errorKind: event?.errorKind ?? null,
        model: event?.model ?? null,
        usage: event?.usage ?? null,
      }),
    );
    return event;
  }

  // Close the header when the run is quiescent: no in-flight turn and no
  // queued/running engine task carries this run. `excludeTaskId` is the task
  // whose turn just ended — the engine flips its state to done only AFTER the
  // turn function returns, so from inside the seam it still reads `running`.
  // Returns the header, or null while something is still pending.
  function settle(runId, { excludeTaskId = null } = {}) {
    if (!runId) return null;
    for (const h of open.values()) {
      if (h.runId === runId) return null;
    }
    for (const t of engineRecords()) {
      if (t?.origin?.fleet?.chain?.runId !== runId) continue;
      if (t.id === excludeTaskId) continue;
      if (t.state === "queued" || t.state === "running") return null;
    }
    if (!db.getRun(runId)) return null;
    const run = db.finalizeRun(runId);
    emit("fleet_run_updated", { run });
    return run;
  }

  // Leaked-header sweep (fix-fleet-run-header-settle): a run whose turn row
  // was written but whose settle never ran stays `open` forever. The settle
  // backstop is IN-MEMORY (the handle map dies with the pod) and the DB-level
  // orphan sweep deliberately skips any run WITH rows ("settle owns it"), so
  // a pod roll between the row write and the settle leaves a header that no
  // future event will ever close. Prod 2026-10-28: four headers sat open
  // 6–30 hours with one finished turn each, and the cockpit timeline showed
  // them as still running.
  //
  // The judgment lives HERE, not in the DB layer: a chain whose upstream turn
  // ended and whose downstream turn has not started yet looks exactly like a
  // leaked header when you only read the rows. The ledger knows the in-flight
  // handles (open map) and the queued engine tasks, so it can tell "still
  // working" from "nobody will ever close this".
  //
  // Only headers past the grace window are considered — a header that opened
  // seconds ago is simply a run that is running.
  function sweepOpenRuns({ now = Date.now(), graceMs = 30 * 60_000 } = {}) {
    const rows = db.listOpenRuns?.({ before: now - graceMs }) ?? [];
    let closed = 0;
    for (const r of rows) {
      // A run with an in-flight turn or a queued task is still working.
      let live = false;
      for (const h of open.values()) {
        if (h.runId === r.run_id) { live = true; break; }
      }
      if (!live) {
        for (const t of engineRecords()) {
          if (t?.origin?.fleet?.chain?.runId !== r.run_id) continue;
          if (t.state === "queued" || t.state === "running") { live = true; break; }
        }
      }
      if (live) continue;
      // Quiescent: finalize from the rows. Zero rows means the turn never
      // wrote anything — the DB-level orphan sweep owns that case (it closes
      // it as failed); here it stays open so that sweep's verdict stands.
      // The header's own `turns` column cannot be used for this test: a
      // leaked header was never finalized, so it still reads 0.
      if (!hasTurnRows(r.run_id)) continue;
      const run = settle(r.run_id);
      if (run && run.status !== "open") {
        closed += 1;
        // Interrupted-beat catch-up (add-rollout-gap-durability): a cron-sourced
        // run killed by a pod roll consumed its cadence beat (lastRun was set at
        // fire time, so the boot downtime catch-up never sees this gap). The
        // host decides — same tolerance rule as the boot pass: makeup or an
        // honest miss, both observable.
        if (r.root_source === "cron" && r.root_member_id && typeof onInterruptedRun === "function") {
          try {
            const verdict = onInterruptedRun({ fleetId: r.fleet_id, memberId: r.root_member_id, runId: r.run_id });
            if (verdict && verdict !== "makeup") {
              console.warn(`[fleet-runs] interrupted cron beat of run ${r.run_id} not made up (${verdict})`);
            }
          } catch (e) {
            console.warn(`[fleet-runs] interrupted-beat makeup for run ${r.run_id} failed: ${e?.message || e}`);
          }
        }
      }
    }
    return closed;
  }

  /**
   * Beat every open claim this process knows about. Called on the same cadence
   * as the trace flush / maintenance tick; a no-op without a claim store.
   *
   * Beating from the LEDGER (not from each execution lane) is the same
   * one-write-point rule as `begin`: the lanes already register here, so a
   * lane that forgot to beat cannot exist.
   */
  function heartbeat({ nowMs = now() } = {}) {
    if (!claims) return 0;
    let beaten = 0;
    for (const h of open.values()) {
      if (!h.claimRef) continue;
      try {
        const out = claims.heartbeat(h.claimRef, { nowMs });
        if (out?.ok) beaten += 1;
      } catch { /* a beat failure must never fail a live turn */ }
    }
    return beaten;
  }

  /**
   * Close lapsed claims as `lease_expired` and, for each, tell the run header
   * honestly: a run whose every attempt lapsed with nothing left to do settles
   * from the rows as usual (they now exist), and the header no longer reads as
   * "still running" purely because nobody closed it.
   *
   * Returns the claims it closed — the caller (server.js) logs and may relay.
   */
  function sweepClaims({ nowMs = now() } = {}) {
    if (!claims) return [];
    let closed = [];
    try {
      closed = claims.sweep({ nowMs }) ?? [];
    } catch (e) {
      console.warn(`[fleet-runs] claim sweep failed: ${e?.message || e}`);
      return [];
    }
    for (const c of closed) {
      try {
        // A lapsed attempt is evidence the run may now be quiescent; settle is
        // already idempotent and refuses while anything is in flight.
        settle(c.run_id, {});
      } catch { /* settle degrades open by design */ }
    }
    return closed;
  }

  /**
   * The one derivation used by every read face (board, console, task query).
   * `everDispatched`/`startedAt` come from the caller that knows them; absent
   * means "no evidence", which derives to `undetermined` rather than a guess.
   */
  function claimState(turnRef, { nowMs = now(), contractEpochMs = null, everDispatched = null, startedAt = null } = {}) {
    if (!claims) return "indeterminate";
    // A caller holding only a handle can pass its ref; a caller with a run+turn
    // can build one against this cell's carrier.
    const ref = turnRef ?? null;
    if (!ref) return "indeterminate";
    try {
      return claims.stateOf(ref, { nowMs, contractEpochMs, everDispatched, startedAt });
    } catch {
      return "indeterminate";
    }
  }

  function hasTurnRows(runId) {    try {
      return db.db?.prepare?.("SELECT COUNT(*) AS n FROM member_turn_events WHERE run_id = ?").get(runId)?.n > 0;
    } catch {
      return false;
    }
  }

  // The chain a downstream task should carry when `handle`'s turn ignites it.
  function chainFor(handle, edgeKind) {
    if (!handle?.runId || !handle?.turnId) return null;
    return { runId: handle.runId, parentTurnId: handle.turnId, edgeKind };
  }

  // 回合令牌 → 句柄（仅本进程、仅在飞）。未知/过期返回 null，调用方落回既有优先级。
  function lookupByToken(token) {
    if (typeof token !== "string" || !token) return null;
    const id = byToken.get(token);
    return id ? open.get(id) ?? null : null;
  }

  function lookupBySession(sessionId) {
    const id = bySession.get(sessionId);
    return id ? open.get(id) ?? null : null;
  }

  // The post's newest in-flight turn (a mid-turn dispatch is attributed to a
  // post, not a session — see routes/fleets.js dispatch).
  function lookupByMember(memberId) {
    const stack = byMember.get(memberId);
    if (!stack?.length) return null;
    return open.get(stack[stack.length - 1]) ?? null;
  }

  // The model the post's in-flight turn is ACTUALLY running on, read from the
  // child's own `request/header` trace rather than from any declared value.
  // Used by the deputy ruling to stamp `resolved_by_model` server-side: a
  // ruling agent's self-report is not evidence, and the declared chain can
  // drift out-of-band (fix-fleet-model-drift). Null when the turn carries no
  // trace, the child has not sent a header yet, or the trace is off — an
  // honest null beats a guess, and the caller must not substitute one.
  function observedModelFor(memberId) {
    const handle = lookupByMember(memberId);
    if (!handle || !trace || !handle.traceTurnId) return null;
    try {
      const turns = trace.getTurn(handle.traceTurnId);
      const headerEvent = turns?.find((t) => t.eventType === "request/header");
      return headerEvent?.payload?.event?.data?.header?.config?.model ?? null;
    } catch {
      return null; // observation never fails the caller
    }
  }

  // Turn-contract admission (agent-turn-contract, explore P2-7). The depth
  // bound is enforced where a chain position is CREATED (dispatch pins 1;
  // handoff/fanout check the declaration at ignition), but the declaration can
  // shrink AFTER a hop was queued: the queued turn then runs past the bound its
  // fleet now states, and nothing refused it — `assertTurnRequest` existed with
  // tests and no production caller. This is the last gate, at the turn, reading
  // the fleet's CURRENT declaration. Returns null (admissible, or not a fleet
  // turn at all — the caller must not treat null as a refusal) or { error }.
  function admission(job) {
    if (!job) return null;
    const fleetId = job.origin?.fleet?.fleetId ?? job.sourceTag?.fleetId ?? null;
    if (!fleetId) return null;
    const fleet = db.getFleet(fleetId);
    // A dead fleet is already handled by the existing skip paths (no post
    // resolves); refusing here too would change their outcome shape.
    if (!fleet) return null;
    const { maxChainDepth } = constraintsOf(fleet.orchestration);
    return assertTurnRequest(buildTurnRequest(job), { maxChainDepth });
  }

  // Collector hook (design D4). `sessionId` is the collector key (rotated child
  // id for fleet rounds); the rows land under the stable mirror session.
  function tap(notif, sessionId, mirrorSessionId = sessionId) {
    const handle = lookupBySession(sessionId);
    if (!handle?.traceTurnId) return false;
    try {
      trace.record(notif, { sessionId: mirrorSessionId, turnId: handle.traceTurnId });
      return true;
    } catch (e) {
      console.warn(`[fleet-runs] trace tap failed: ${e?.message || e}`);
      return false;
    }
  }

  function openTurns() {
    return [...open.values()];
  }

  // Stop a run (add-fleet-run-budget D3): stamp the header, then abort the
  // sessions this run currently has in flight. The abort registry is the same
  // one the bridge uses (ctx.taskTurnRegistry, keyed by the rotated child
  // session id) — an aborted turn lands as `interrupted`, which is exactly the
  // honest outcome for "the owner/budget stopped this run", not a failure.
  // Returns { run, abortedTurns } or null when the run is unknown.
  function stopRun(runId, { reason = "cancelled by owner", abortTurn = null, now = Date.now() } = {}) {
    if (!runId || !db.getRun(runId)) return null;
    const run = db.stopRun(runId, { reason, at: now });
    let aborted = 0;
    if (typeof abortTurn === "function") {
      const sessions = new Set();
      for (const h of open.values()) {
        if (h.runId !== runId) continue;
        for (const sid of h.sessionIds ?? []) if (sid) sessions.add(sid);
      }
      for (const sid of sessions) {
        try {
          aborted += abortTurn(sid, reason) === false ? 0 : 1;
        } catch { /* a wedged abort must not fail the stop */ }
      }
    }
    emit("fleet_run_updated", { run });
    return { run, abortedTurns: aborted };
  }

  return { begin, end, settle, sweepOpenRuns, sweepClaims, heartbeat, chainFor, admission, lookupBySession, lookupByToken, lookupByMember, observedModelFor, tap, openTurns, stopRun, tapEnabled: traceTapEnabled, claimState };
}
