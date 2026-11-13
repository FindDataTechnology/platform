# Design: add-worker-pool

## Context

See `proposal.md` (phase ③; ADR 0005). Facts that shape the approach:

- `DshBridge` is a multi-instance class with its own spawn/exit/backoff lifecycle; the primary is constructed in server.js with patch paths + `agentPreset: ctx.currentPreset`.
- Profile composition (`dsh-profile.js`) writes into a module-constant `DSH_HOME`; parameterizing it per worker would fork the bootstrap path (the fresh-home lessons say composition is the risky part) and require cross-process DB access. The primary's own preset switch already proves the model: **same home, same patches, different `agentPreset`**.
- `dsh-events.js` owns ONE bridge's events; the collector contract (`sessionCollectors` keyed by session id) is persona-agnostic and already serves cron/bots.
- The engine's `executionQueue` promise chain serializes everything; the aggregator chains onto it.

## Goals / Non-Goals

**Goals:**
- Parallel task execution with persona affinity; primary untouched by tasks while workers exist.
- Zero behavior change at `TASK_WORKER_MAX=0` (the regression guarantee).
- Workers reuse the primary's composition and the collector contract — no new bootstrap path, no new persistence.

**Non-Goals:**
- Per-worker homes (dropped: shared composed profile, session-id isolation — see D1).
- Worker-side interactive chat, steering, or model overrides.
- Dynamic cap changes without restart; queue prioritization beyond FIFO.

## Decisions

### D1: Workers share the cell's composed profile, pinned by `agentPreset`
A worker is `new DshBridge({ provider, model, cwd, patch paths, agentPreset: persona, env: dshChildEnv, onEvent: <worker pump> })` — exactly the primary's construction with a different preset and event sink. The home, patches, credentials, and HMR watchers are shared, which is precisely what the primary's preset switching already does today; outputs stay isolated because every task already runs in its own dedicated session id.
*Alternative*: per-worker `DSH_HOME` with composed copies — rejected: forks the bootstrap path (the fresh-home crash class), needs cross-process SQLite, and buys isolation the session scoping already provides.

### D2: The pool is the engine's slot dispatcher; the queue becomes a scheduler
`server/worker-slots.js` owns `Map<persona, worker[]>`-shaped state (idle/busy per worker) and registers with the engine via a dispatch hook. The engine's due-execution handling changes from "chain onto one serial queue" to: ask the pool — worker match → run on the worker (concurrent); no worker possible (cap 0 / saturated) → the primary path, chained on the serial queue exactly as today. The primary serial chain and its guards are untouched.
*Alternative*: workers register as extra entries in the same promise chain — rejected: a chain serializes; parallelism needs assignment, not ordering.

### D3: Worker events go to a worker-only pump
Each worker's `onEvent` routes session events to the collector registered for that worker's current task session (the cron-runner `collectTurn` contract, reused verbatim) and to nothing else — no web broadcast, no trace, no agent-change translation. Bridge exits abort that worker's in-flight collector (the abort-registry pattern, per worker).

### D4: The aggregator waits out in-flight workers
The summary injection must not overlap a still-streaming child (it could fire the moment states flip, while worker output flushes). The aggregator's `chainTurn` gains a drain step: await the pool's in-flight executions before mirroring the web prompt path. `waitForIdle` on the primary remains for the live-turn case.

### D5: Reap and cap
`TASK_WORKER_MAX` (integer ≥ 0, default 0) read at boot; reap scan every 60s shuts workers idle > 5 min (`bridge.close()`, remove from pool); pool-state broadcasts (`worker_pool` event with per-worker {persona, state}) on spawn/reap/busy/idle.

## Risks / Trade-offs

- [Shared home concurrent access] → same-file access today is HMR-designed (patch rewrites hot-swap); workers only read the same patches. Session logs are per-session files.
- [Gateway concurrency] → parallel turns multiply load; rehearsals account for it (rehearsal budget rule).
- [Worker spawn latency on cold fan-out] → first fan-out pays ~one bridge boot per persona; subsequent ones reuse warm workers within the reap window.
- [Queue starvation of the primary path] → none by construction: workers and the primary are disjoint execution surfaces; cap 0 restores the exact serial policy.

## Migration Plan

1. Engine dispatch hook + pool module (inert at cap 0) — deploy-safe no-op.
2. Worker construction + collector pump + parallel dispatch.
3. Reap/cap/broadcast + env/DEPLOY docs (`fd-prod: 0`, demo `.env: 3`).
4. Rollback: `TASK_WORKER_MAX=0` restores serial semantics without a code rollback.

## Open Questions

- Whether worker turn errors should also record token usage from worker finish chunks — expected yes for free (same collector); confirm in implementation.
