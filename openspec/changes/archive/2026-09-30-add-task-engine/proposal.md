# Proposal: add-task-engine

## Why

The 指挥层 program (chat-side delegation, parallel worker slots, an MC operator console) all needs one thing that does not exist yet: a task engine with a real lifecycle. Today the only "task" is the cron job — scheduling-shaped, no failure states beyond history rows, no re-run, no extensible target model — while the execution channel it rides (`waitForIdle` → preset switch → prompt → collector → persist) is already proven generic by its two consumers (bot-relay, cron). Per ADR 0006, we do not build a second engine beside cron; we generalize cron into the unified task engine, so that "任务" is one concept in the product before three more surfaces start using the word. This change is phase ① of four (② delegation tools, ③ worker pool, ④ MC bridge); it ships standalone value: a single /tasks 任务中心, visible lifecycle (failed/interrupted with manual re-run), and the slot abstraction that later phases plug into.

## What Changes

- **The cron engine generalizes into a task engine.** A task is `{ target, prompt, dedicated session, trigger, lifecycle, result }`. The schedule becomes a trigger kind: a cron job is a task with a schedule trigger, created and managed exactly as today (timezone semantics, pause/resume/run-now, one-shot and recurring, agent scheduling tools all keep working).
- **Task lifecycle is explicit**: `queued → running → done | failed | interrupted`, persisted per task. No auto-retry (LLM spend); failed and interrupted tasks expose manual re-run. In-flight tasks at restart/crash are marked `interrupted` (not silently re-run); `queued` tasks resume after restart — matching cron's downtime determinism, now stated at engine level.
- **Execution slot abstraction** (ADR 0005): the engine dispatches to slots. This change implements only the primary slot — the existing serial semantics verbatim (queue behind an active turn, one task at a time, preset switch before prompting). Worker slots are interface-reserved for change ③; no parallelism ships here.
- **`target` is an extensible `{ type, ref }`**; v1 implements `persona` only (the current preset-binding semantics, restated), leaving the field shape ready for later target types without data-model churn.
- **/tasks becomes the 唯一任务中心**: the scheduled-tasks surface widens to list all tasks with trigger, target persona, lifecycle state, and re-run affordances; scheduled tasks appear as the schedule-trigger category.

Non-goals: delegation tools, task cards in chat, and the aggregation turn (② `agent-delegation-tools`); worker slots and parallel execution (③ `worker-pool`); the MC bridge and console (④); review/approval gates (MC-side concern); auto-retry and per-task model overrides; sidebar grouping of task sessions by mission.

## Capabilities

### New Capabilities

- `task-engine`: the unified task model — task identity (target/trigger/session binding), lifecycle states and transitions, restart semantics (queued resumes, running → interrupted), the execution-slot abstraction with the serial primary-slot policy, and manual re-run.

### Modified Capabilities

- `cron-module`: scheduling becomes a trigger front-end over the task engine — requirements restated in task terms (jobs are tasks with schedule triggers); engine-level semantics (queue-behind-turn, sequential execution, preset switching, downtime behavior) move to `task-engine` and are referenced, not duplicated.
- `scheduled-tasks-ui`: the /tasks surface becomes the unified task center — all tasks (not only scheduled ones) with lifecycle state and re-run; scheduled tasks render as the schedule-trigger category with today's management affordances preserved.

## Impact

- **Code**: `cron.js` / `cron-store` (records generalize into tasks: trigger + lifecycle fields; state machine), `server/cron-runner.js` (becomes the primary-slot executor — semantics unchanged), `db.js` (additive schema migration for task records), web `/tasks` page (task-center widening), e2e (existing cron suites must pass unchanged; new lifecycle/re-run/interrupted coverage).
- **Behavioral safety**: serial execution semantics are preserved verbatim — existing cron users see no behavioral change beyond richer states in the UI; the schedule tool contract (`agent-scheduling-tools`) is untouched this phase.
- **Sequencing**: starts once `fix-agent-workspace` wraps (4/6); not gated on `add-session-ownership` / `perf-session-open` — the engine's dedicated-session creation references owner-stamping semantics in design, resolved when those land.
- **Decisions recorded**: ADR 0006 (unification), ADR 0005 (slots, serial default); glossary terms 任务/执行槽/工作槽 already in `CONTEXT.md`.
