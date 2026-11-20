// Fleet materialization & on-duty derivation (agent-fleet-core).
//
// The fleet layer OWNS NO SCHEDULER: a member's cadenceSpec materializes as a
// task-engine cron job tagged sourceTag { fleetId, memberId }, and this module
// is the diff engine that keeps (members × cadence) and (tagged tasks) in
// sync after every fleet write. The task engine stays the single execution
// source of truth; reconcile only adds / rewrites-in-place / pauses / removes.
//
// Pure-core style: the engine face (`cronApi`) and target resolution
// (`resolveTarget`) are injectable so tests drive the diff without a live
// catalog. The derived on-duty view is a read-time computation — statuses are
// NEVER stored (design D5).

import cronParser from "cron-parser";

// ── Schedule math ────────────────────────────────────────────────────────────

// Approximate the firing period of a cron expression (ms) from two forward
// occurrences. Null when unparseable — callers fall back to the 6h floor.
//
// Memoized per (cron, tz, day). Parsing with a tz is expensive — cron-parser
// builds a Luxon zone per parse and iterates inside it: measured ~40ms per
// call for `0 9 * * *` in Asia/Shanghai (9ms with no tz). The roster derives a
// stale window per member AND deriveMemberStatus asks again, so a 60-post
// fleet paid seconds of pure calendar math per read — on the same event loop
// that serves the chat WebSocket. The period is a pure function of
// (cron, tz) within a day; the day is part of the key so a DST shift is
// picked up by the next read instead of being frozen for the process.
const periodCache = new Map();
const PERIOD_CACHE_MAX = 512;

export function cronPeriodMs(cron, tz) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${cron}|${tz || ""}|${day}`;
  const cached = periodCache.get(key);
  if (cached !== undefined) return cached;
  let value = null;
  try {
    const iter = cronParser.parseExpression(cron, { tz: tz || undefined });
    const a = iter.next().toDate();
    const b = iter.next().toDate();
    const ms = b - a;
    value = Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    value = null;
  }
  if (periodCache.size >= PERIOD_CACHE_MAX) periodCache.clear();
  periodCache.set(key, value);
  return value;
}

const STALE_FLOOR_MS = 6 * 60 * 60 * 1000;

// Tolerance window before a post reads 失联: proportional to the cadence
// (2 × period), never below 6h (design D5).
export function staleWindowMs(cron, tz) {
  const period = cronPeriodMs(cron, tz);
  if (!period) return STALE_FLOOR_MS;
  return Math.max(2 * period, STALE_FLOOR_MS);
}

// ── Materialization spec ─────────────────────────────────────────────────────

// The addJob/updateJob arguments a member's cadence materializes into. Pure —
// target lookups are the route layer's job; here we only map shapes.
export function materializedSpec({ fleet, member, rosterPresetId = (id) => id, clusterName = null }) {
  const base = {
    cron: member.cadence.cron,
    tz: member.cadence.tz || null,
    prompt: member.cadence.promptTemplate,
    sessionTitle: `${fleet.name} · ${member.title}`,
    sourceTag: { fleetId: fleet.id, memberId: member.id },
    // Turn carrier (add-fleet-carrier): the member's placement rides the task
    // so the dispatch face resolves per task. Null = unset → auto.
    carrier: member.carrier ?? null,
    packId: member.packId ?? null,
  };
  // 岗位级顶替豁免（3.2）：manifest 声明 `noSupersede: true` 的岗位，其排队轮
  // 不参与同岗位顶替（`supersedeQueuedForPost` 见该字段直接跳过）。
  // 不声明时不写这个键 —— 记录的形状与加入本字段之前完全一致。
  if (member.noSupersede === true) base.noSupersede = true;
  if (member.targetKind === "cluster") {
    return { ...base, clusterId: member.targetId, ...(clusterName ? { clusterName } : {}) };
  }
  if (member.targetKind === "a2a") {
    return { ...base, agent: member.targetId };
  }
  if (member.targetKind === "tool") {
    // Tool posts (add-tool-posts): the target is "server::tool" — a
    // deterministic MCP call, prompt is the JSON arguments verbatim.
    return { ...base, tool: member.targetId };
  }
  // persona: catalog agent id → dsh roster preset id (the one mapping point,
  // same as cluster member resolution).
  return { ...base, preset: rosterPresetId(member.targetId) };
}

// Field-level drift between the live task and the desired spec (both addJob
// shapes). Used by reconcile to rewrite in place — the task id (and its bound
// session) never changes on cadence edits or swaps.
export function specDrift(task, spec) {
  const changes = {};
  if ((task.cron ?? null) !== (spec.cron ?? null)) changes.cron = spec.cron;
  // Carrier drift (add-fleet-carrier): placement-only change — the task id,
  // bound session and execution history stay put (换身体不换会话).
  if ((task.carrier ?? null) !== (spec.carrier ?? null)) changes.carrier = spec.carrier;
  if ((task.packId ?? null) !== (spec.packId ?? null)) changes.packId = spec.packId;
  // 豁免是岗位属性，改它要能就地生效（改的是判定，不换会话/历史）。
  if ((task.noSupersede === true) !== (spec.noSupersede === true)) {
    changes.noSupersede = spec.noSupersede === true;
  }
  if ((task.tz ?? null) !== (spec.tz ?? null)) changes.tz = spec.tz;
  if ((task.prompt ?? null) !== (spec.prompt ?? null)) changes.prompt = spec.prompt;
  if ((task.sessionTitle ?? null) !== (spec.sessionTitle ?? null)) changes.sessionTitle = spec.sessionTitle;

  const desiredTargetType = spec.clusterId ? "cluster" : spec.agent ? "a2a" : spec.tool ? "tool" : "persona";
  const desiredPreset = spec.clusterId ?? spec.agent ?? spec.tool ?? spec.preset ?? null;
  const targetTypeChanged =
    (task.targetType ?? "persona") !== desiredTargetType ||
    (task.preset ?? null) !== desiredPreset;
  if (targetTypeChanged) {
    if (desiredTargetType === "cluster") {
      changes.clusterId = spec.clusterId;
      if (spec.clusterName) changes.clusterName = spec.clusterName;
    } else if (desiredTargetType === "a2a") {
      changes.agent = spec.agent;
    } else if (desiredTargetType === "tool") {
      changes.tool = spec.tool;
    } else {
      changes.preset = spec.preset ?? null;
    }
  } else if (desiredTargetType === "cluster" && spec.clusterName && (task.clusterName ?? null) !== spec.clusterName) {
    changes.clusterName = spec.clusterName;
  }
  return changes;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

// Diff a fleet's members against its sourceTag-tagged tasks and converge:
//   create missing tasks, rewrite drifted ones IN PLACE (id/session stable),
//   sync the paused bit to (fleet paused ∨ member paused ∨ vacant post), and
//   remove orphaned tasks (member gone, or cadence withdrawn → passive post).
// Idempotent by construction: a second pass with no state change touches
// nothing. Returns the actions taken (empty arrays on a no-op pass).
export async function reconcileFleet({
  fleetId,
  db, // fleets-db facade
  cronApi, // { listJobs, addJob, updateJob, pauseJob, resumeJob, removeJob }
  resolveTarget, // (member) => ({ alive: boolean, clusterName?: string })
  rosterPresetId = (id) => id,
  // Pack memory policy release (add-pack-memory-declaration 4.2). Injected so a
  // test can observe the decision without a memory service; absent ⇒ the real
  // one runs, and any failure degrades open.
  releaseMemoryPolicy = null,
}) {
  const fleet = db.getFleet(fleetId);
  if (!fleet) return { skipped: "fleet not found" };

  const members = db.listMembers(fleetId);
  const memberById = new Map(members.map((m) => [m.id, m]));
  // The sweep manages MATERIALIZED RHYTHM tasks only — one-shot manual turns
  // (event wakes, execute-now, delegation) carry the same sourceTag but are
  // nobody's cadence object; sweeping them as "orphans" ate queued event
  // wakes on the next fleet PATCH (production walk 2026-11-03, P3).
  const tagged = cronApi.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId && j.trigger === "schedule");

  const out = { created: [], updated: [], paused: [], resumed: [], removed: [], respectedPause: [], deduped: [] };

  // Orphans first: members deleted, or cadence withdrawn (passive posts
  // materialize nothing — design D10).
  for (const task of tagged) {
    const member = memberById.get(task.sourceTag.memberId);
    if (!member || !member.cadence) {
      await cronApi.removeJob(task.id);
      out.removed.push(task.id);
    }
  }

  // ── Duplicate rhythm tasks for one post ──────────────────────────────────
  // The per-member index below holds ONE task, so a second scheduled task
  // tagged with the same memberId is invisible to the diff AND spared by the
  // orphan sweep above (its member and cadence both still exist). It keeps
  // firing forever while every read surface reports a single cadence — the
  // post runs twice, the console shows one row, and `deriveMemberStatus` reads
  // whichever task the map happened to keep.
  //
  // Live 2026-11-14 (投研晨会集群): two `trigger=schedule` tasks per post for
  // 宏观研究员 and 行业研究员, all four unpaused. The same morning produced
  // two rounds from kfcj84 (01:30Z, 02:57Z) plus one from 8qbad7 (01:25Z) for
  // ONE member. Nothing in the platform could ever collapse them.
  //
  // Collapse deterministically and reversibly: keep the task the post is
  // actually driven by (newest lastRun, then oldest createdAt, then id) and
  // PAUSE the rest — removal would throw away the only record of those rounds,
  // and a pause is an operator-visible, resumable state. `pausedBy` stays
  // "fleet" (pauseJob's default): this IS the fleet layer parking a row it
  // does not schedule.
  const removed = new Set(out.removed);
  const byMember = new Map();
  for (const task of tagged) {
    if (removed.has(task.id)) continue;
    const key = task.sourceTag.memberId;
    const list = byMember.get(key);
    if (list) list.push(task);
    else byMember.set(key, [task]);
  }
  const taskByMember = new Map();
  for (const [memberId, list] of byMember) {
    const ranked = [...list].sort((a, b) => {
      const la = String(a.lastRun ?? "");
      const lb = String(b.lastRun ?? "");
      if (la !== lb) return lb.localeCompare(la);
      const ca = String(a.createdAt ?? "");
      const cb = String(b.createdAt ?? "");
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.id).localeCompare(String(b.id));
    });
    const [keep, ...extra] = ranked;
    taskByMember.set(memberId, keep);
    for (const dup of extra) {
      if (dup.paused) continue;
      await cronApi.pauseJob(dup.id);
      out.deduped.push(dup.id);
    }
  }

  for (const member of members) {
    if (!member.cadence) continue;

    const target = resolveTarget(member);
    // Two pause layers + vacancy: a post whose incumbent object no longer
    // exists must stop firing (待补岗 stops new rounds; restaff re-arms).
    const desiredPaused =
      fleet.state !== "active" || member.cadence.enabled === false || !target.alive;

    const spec = materializedSpec({
      fleet,
      member,
      rosterPresetId,
      clusterName: target.clusterName ?? null,
    });
    const existing = taskByMember.get(member.id);

    if (!existing) {
      // Archived fleets never (re)materialize — archive is stop-and-keep.
      if (fleet.state === "archived") continue;
      const created = await cronApi.addJob(spec);
      if (desiredPaused && created?.id) {
        await cronApi.pauseJob(created.id);
        out.paused.push(created.id);
      }
      out.created.push(created?.id ?? null);
      continue;
    }

    const drift = specDrift(existing, spec);
    if (Object.keys(drift).length > 0) {
      await cronApi.updateJob(existing.id, drift);
      out.updated.push(existing.id);
    }
    if (desiredPaused && !existing.paused) {
      await cronApi.pauseJob(existing.id);
      out.paused.push(existing.id);
    } else if (!desiredPaused && existing.paused) {
      // An owner's stop is its own layer (fix-fleet-operator-pause-durability):
      // `desiredPaused` only says what the FLEET wants, so resuming here undid
      // an owner's pause on the next catalog refresh — measured 2026-11-10, a
      // paused member task came back minutes later with nobody touching it.
      // Respect it and report it, so a caller can say "N posts stopped by the
      // owner" instead of silently leaving them parked.
      // Missing marker = pre-split record → "fleet", i.e. the old behaviour.
      if ((existing.pausedBy ?? "fleet") === "operator") {
        out.respectedPause.push(existing.id);
      } else {
        await cronApi.resumeJob(existing.id);
        out.resumed.push(existing.id);
      }
    }
  }

  // Pack memory policy on archive (add-pack-memory-declaration 4.2).
  //
  // The policy row is keyed by PACK, not by fleet: every team landed from one
  // pack shares `d-<pack>` and its document. So "this team was archived" is not
  // by itself a reason to clear it — another owner's team on the same pack would
  // silently lose its distillation setting. Clear only when this was the last
  // live team on that pack, which is the reading of the spec that matches the
  // storage's real granularity.
  const packId = fleet.state === "archived" ? fleet.sourceTemplate?.packId : null;
  if (packId) {
    const liveOnPack = db.listFleets().filter(
      (f) => f.state !== "archived" && f.sourceTemplate?.packId === packId,
    ).length;
    if (liveOnPack === 0) {
      try {
        const release = releaseMemoryPolicy ?? (await import("./pack-memory-policy-landing.js")).releasePackMemoryPolicy;
        out.memoryPolicy = await release({ packId, liveFleets: 0 });
      } catch (err) {
        // Degrade open: an archived fleet must finish archiving even when the
        // memory service is unreachable; the reason is reported, not thrown.
        out.memoryPolicy = { ok: false, action: "failed", reason: String(err?.message ?? err) };
      }
    }
  }

  return out;
}

// Reconcile every fleet in the store (catalog-change hook): a catalog refresh
// can kill a post's incumbent (persona uninstalled) or revive one — converge
// all materialized tasks in one pass. Per-fleet errors never stop the loop.
export async function reconcileAllFleets({ db, cronApi, resolveTarget, rosterPresetId = (id) => id }) {
  const results = [];
  for (const fleet of db.listFleets()) {
    try {
      const actions = await reconcileFleet({
        fleetId: fleet.id,
        db,
        cronApi,
        resolveTarget,
        rosterPresetId,
      });
      results.push({ fleetId: fleet.id, ...actions });
    } catch (err) {
      results.push({ fleetId: fleet.id, error: err.message });
    }
  }
  return results;
}

// ── On-duty derivation (read-time, never stored) ─────────────────────────────

// Precedence: vacant (incumbent object gone) → passive (no cadence) → paused
// (either pause layer) → missing (no task / beyond tolerance window) →
// failing (consecutive failed rounds) → on_duty.
// The tolerance is DUAL-WINDOW once the report lane exists (agent-fleet-
// report-lane): an execution beyond the window OR a report beyond the window
// (when the post has ever reported) both read 失联 — evidence names which
// window fired. The evidence fields explain WHY a post reads the way it does
// (design D5).
//
// `failureStreak`/`failureSince`/`lastFailureKind` come from the turn stream
// (fix-fleet-failure-visibility D3): the function stays pure, the caller has
// already read the streak. Without them a post that failed twelve rounds in a
// row still read `on_duty` — the console was green while nothing was produced.
const FAILING_STREAK_DEFAULT = 3;
function failingThreshold() {
  const raw = Number(process.env.PLATFORM_FLEET_FAILING_STREAK);
  return Number.isFinite(raw) && raw > 0 ? raw : FAILING_STREAK_DEFAULT;
}

export function deriveMemberStatus({
  member,
  fleet,
  task,
  targetAlive,
  latestReport = null,
  now = Date.now(),
  failureStreak = 0,
  failureSince = null,
  lastFailureKind = null,
  // Presence reads REAL rounds only (fix-fleet-turn-veracity D3): the caller
  // passes the newest real turn's endedAt when the turn stream holds any
  // events; undefined = fall back to the engine's task.lastRun (pre-stream
  // history), null = the stream exists but holds only skips — presence MUST
  // NOT advance on skipped rounds (a platform outage is not "the post just
  // worked"; sustained skips degrade to missing with the count named).
  effectiveLastRunAt = undefined,
  // Skipped rounds inside the tolerance window — evidence for the
  // missing-reason note (skipped = fired but never ran ≠ missed = never fired).
  skippedRounds = 0,
}) {
  const evidence = {
    lastRunAt: task?.lastRun ?? null,
    nextRunAt: task?.nextRun ?? null,
    staleWindowMs: member.cadence ? staleWindowMs(member.cadence.cron, member.cadence.tz) : null,
    fleetPaused: fleet?.state === "paused",
    memberPaused: member.cadence ? member.cadence.enabled === false : false,
    latestReportAt: latestReport?.createdAt ?? null,
    hitWindow: null,
    // Downtime accounting (P2, 2026-10-26): a trigger covered by a platform
    // restart used to be a log line and nothing else — an unattended post
    // silently lost a round and later read `missing` with no explanation. The
    // count, its reason and whether a make-up run is in flight ride the
    // evidence so the cockpit and the post card can SAY it.
    missedRounds: task?.missed ?? 0,
    lastMissedAt: task?.lastMissedAt ?? null,
    lastMissedReason: task?.lastMissedReason ?? null,
    catchUpPending: task?.catchUpPending === true,
    // Failure dimension (fix-fleet-failure-visibility D4): the streak and its
    // attribution ride every read, so a downgraded post can always say why.
    failureStreak: failureStreak ?? 0,
    failingSince: failureSince ?? null,
    lastErrorKind: lastFailureKind ?? null,
    skippedRounds: skippedRounds ?? 0,
  };

  if (targetAlive === false) {
    // Two birth-paths to a vacancy, two honest reasons: the empty-targetId
    // sentinel is minted ONLY by the provisioner's unique-post conflict
    // degradation (the target exists but holds a post elsewhere); any other
    // dead targetRef is the "deleted afterwards" case.
    return {
      status: "vacant",
      reason: member.targetId
        ? "target object no longer exists"
        : "no incumbent assigned — uniqueness conflict at instantiation",
      evidence,
    };
  }
  if (!member.cadence) {
    return { status: "passive", reason: "no cadence — runs only when delegated or replied to", evidence };
  }
  if (fleet?.state !== "active" || member.cadence.enabled === false) {
    return { status: "paused", reason: fleet?.state !== "active" ? "fleet paused" : "member paused", evidence };
  }
  if (!task) {
    return { status: "missing", reason: "no materialized task", evidence };
  }

  const window = evidence.staleWindowMs;
  const skippedNote = evidence.skippedRounds > 0
    ? ` — ${evidence.skippedRounds} round(s) skipped: runtime unavailable or lane breaker open`
    : "";
  const lastRunMs = effectiveLastRunAt !== undefined
    ? (Number.isFinite(effectiveLastRunAt) ? effectiveLastRunAt : null)
    : (task.lastRun ? Date.parse(task.lastRun) : null);
  const executionStale = (ms) => ms != null && Number.isFinite(ms) && now - ms > window;

  if (lastRunMs != null && Number.isFinite(lastRunMs)) {
    if (executionStale(lastRunMs)) {
      evidence.hitWindow = "execution";
      // A gap caused by downtime reads differently from a post that simply
      // stopped working (P2, 2026-10-26): name the cause and the pending
      // make-up so triage does not chase a healthy post.
      const downtimeNote = evidence.lastMissedReason === "downtime"
        ? ` — ${evidence.missedRounds} round(s) skipped by platform downtime${evidence.catchUpPending ? ", catch-up run in flight" : ""}`
        : "";
      return { status: "missing", reason: `no execution for over the tolerance window (${Math.round(window / 3_600_000)}h)${downtimeNote}${skippedNote}`, evidence };
    }
  } else {
    // Never ran: on-duty until the first occurrence is due AND the window has
    // passed since materialization (createdAt is ISO from task-engine).
    const createdMs = task.createdAt ? Date.parse(task.createdAt) : null;
    if (createdMs != null && Number.isFinite(createdMs) && now - createdMs > window) {
      evidence.hitWindow = "execution";
      return { status: "missing", reason: `materialized but never executed past the tolerance window${skippedNote}`, evidence };
    }
    return { status: "on_duty", reason: "awaiting first scheduled run", evidence };
  }

  // Execution is healthy — the report window still applies once the post has
  // ever reported (a patrol that never hears from a reporting post is stale).
  if (evidence.latestReportAt != null && now - evidence.latestReportAt > window) {
    evidence.hitWindow = "report";
    return { status: "missing", reason: `no report for over the tolerance window (${Math.round(window / 3_600_000)}h)`, evidence };
  }

  // Failure dimension (fix-fleet-failure-visibility D2/D5): a recent execution
  // is not the same as a WORKING post. Consecutive failed rounds downgrade the
  // status — a green console over twelve failed rounds is the one failure mode
  // an unattended product cannot afford. `missing` keeps precedence above
  // (losing the signal entirely is worse than failing repeatedly); `interrupted`
  // rounds never count as failures, and one successful round clears this.
  const threshold = failingThreshold();
  if (evidence.failureStreak >= threshold) {
    const kind = evidence.lastErrorKind ? ` (last: ${evidence.lastErrorKind})` : "";
    return {
      status: "failing",
      reason: `${evidence.failureStreak} consecutive failed rounds${kind}`,
      evidence,
    };
  }
  return { status: "on_duty", reason: "recent execution within tolerance", evidence };
}
