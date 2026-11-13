# Design: add-task-engine

## Context

See `proposal.md` for motivation (phase ① of the 指挥层 program; ADR 0006 unification, ADR 0005 slot abstraction). Current state that shapes the approach:

- The execution channel is proven generic: `server/cron-runner.js` runs `waitForIdle → switchPresetForJob → prompt → sessionCollector → persist → sessions refresh`, and the collector pattern already serves two consumers (bot-relay, cron).
- The cell runtime is structurally serial: one dsh bridge, one turn at a time, runtime mutations serialized through `runExclusiveRuntimeMutation` (`server/runtime-bindings.js`). Nesting that lock deadlocks (lesson recorded from the cron capability work) — the primary-slot executor must reuse the existing serialization points, never wrap them.
- Schedule state and history live in the cron store under `cron-store/`; jobs carry preset + session binding, timezone, pause/resume, missed/expired markers, bounded history.
- The `/tasks` surfaces (web + MP) are driven by `cron_*` WS events; e2e suites assert current cron behavior.
- `add-session-ownership` (in flight) stamps owners on first mirrored message; engine-created sessions get their first message from the engine, not a user connection.

## Goals / Non-Goals

**Goals:**
- One task store and one execution loop for all triggers; schedule semantics preserved byte-for-byte in behavior.
- Explicit lifecycle (`queued/running/done/failed/interrupted`) with manual re-run; restart determinism stated at engine level.
- A minimal slot seam that change ③ (worker-pool) can implement without touching the task model or the scheduling front-end.

**Non-Goals (design-level):**
- No slot registry or worker spawning now — the seam is a single named executor, not a plugin system.
- No new event channel — `cron_*` remains the transport.
- No UI redesign beyond widening the existing list/actions; trigger-category filtering beyond schedule is ②'s concern.

## Decisions

### D1: One store, extended in place — no second table
Extend the existing cron/task store additively: task rows gain `trigger` (kind + schedule fields already exist for schedule triggers), `target` (`type`, `ref`), and `state`; per-execution outcomes live in the history rows that already exist, with the task's `state` column mirroring the latest execution. Existing job rows migrate in one transaction to `trigger=schedule`, `target={persona, <preset>}`, state derived from history.
*Alternative*: a new `tasks` table with jobs backfilled into it — rejected: forks the queueing/restore logic across two tables and orphans job ids that clients, e2e, and share links already reference. Ids stay stable.

### D2: The primary-slot executor is today's cron-runner, re-homed
`cron-runner.js` becomes the engine's primary-slot executor essentially verbatim (same waitForIdle, same preset-switch retry loop, same collector, same `abortCronTurns` registry on bridge restart, same sessions-refresh broadcast). The engine loop (successor of cron.js's serialized queue) enqueues executions and marks state transitions; scheduling code shrinks to computing *when* to enqueue.
*Alternative*: rewrite the executor against a slot interface now — rejected: the current flow is battle-tested (bot-relay lineage, bridge-restart aborts, preset-drift retries); ③ will extract the interface from working code, not from a redesign.

### D3: `cron_*` events stay the transport; payloads widen
Lifecycle changes ride the existing `cron_*` event types with added task fields (trigger kind, state, target). No `task_*` channel is introduced in ①; new consumers (② task cards) will reuse the same surface.
*Alternative*: parallel `task_*` event stream — rejected: every client store would have to merge two streams for one concept; the compat cost is permanent.

### D4: Restart semantics are load-time state repair
At cell start the engine repairs task state before scheduling restores: `running` → `interrupted` (never re-executed), `queued` → re-enqueued to run once. Missed-occurrence and expiry handling stays in the schedule loader exactly as today (cron-module's downtime requirements), producing missed markers / `expired` state respectively.
*Alternative*: re-run `interrupted` executions automatically — rejected: doubles LLM spend on half-finished context; manual re-run is the explicit door (R1 decision).

### D5: Re-run is enqueue-same-task
Re-run enqueues a fresh execution against the same task identity (target, prompt, dedicated session). If an execution is already `queued` or `running`, re-run is a no-op returning current state (no duplicate queue entries).

### D6: Engine-created sessions and ownership
Task sessions are recorded with the engine as author, as today. When `add-session-ownership` lands, owner-stamping for engine-created sessions follows its "first mirrored message" rule; the open question below tracks the exact attribution and is ②'s to resolve — no schema decision in ① is affected either way.

## Risks / Trade-offs

- [Live job rows migrate under active fd-prod cells] → additive columns + one-transaction backfill; old columns remain valid so a rollback image running old code simply ignores the new fields.
- [runExclusive nesting deadlock resurfaces] → D2 keeps the exact serialization topology; any new engine-level lock wraps only its own queue, never a path that already holds the runtime lock.
- [Bridge restart mid-execution] → existing abort registry kills the collector promptly; load-time repair (D4) guarantees the persisted state converges to `interrupted`.
- [e2e continuity] → existing cron suites must pass unchanged (behavior-preservation gate); new lifecycle/re-run/interrupted coverage added alongside, not replacing.

## Migration Plan

1. Schema: additive columns on the task store + one-transaction backfill of existing jobs (id-preserving).
2. Deploy: no special order; serial semantics unchanged, so no user-visible behavior shift beyond richer `/tasks` states.
3. Rollback: revert image; new columns are inert to old code.

## Open Questions

- Exact owner attribution for engine-created task sessions once `add-session-ownership` lands (deploy-owner vs requesting-connection email for tool-created schedules) — resolvable in ② without touching ①'s schema or API.
