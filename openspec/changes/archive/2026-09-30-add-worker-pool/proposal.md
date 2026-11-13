# Proposal: add-worker-pool

## Why

指挥层 phase ③ — the missing half of the acceptance picture. Phases ① (task engine) and ② (delegation) deliver "一句话 → 拆解 → 分身领任务 → 汇总落回聊天", but the 分身 still run one at a time on the interactive runtime: a fan-out to three personas queues serially, paying a runtime restart per persona switch, while the user waits. The engine's execution-slot abstraction (ADR 0005) was built for exactly this change: workers are additional dsh runtime instances — one persona each, spawned on demand — so delegated tasks run in parallel and the primary runtime stays free for the conversation. `DshBridge` is already a multi-instance class, and per-worker agent homes are a proven pattern in the e2e harness.

## What Changes

- **Worker slots**: the engine dispatches eligible task executions to worker slots — on-demand `DshBridge` instances, each bound to ONE persona for its lifetime (zero persona switches, zero restarts) and sharing the cell's composed profile (the same home, patches, and credentials the primary runtime restarts and preset-switches on today — no parallel bootstrap path; session-id scoping keeps outputs isolated). The primary slot stays interactive: when at least one worker is available, tasks never touch the primary runtime; with `TASK_WORKER_MAX=0` (serial mode) everything runs on the primary exactly as today.
- **Persona affinity dispatch**: a task due for persona P goes to an idle worker bound to P; none exists → spawn one if under the cap; at cap → queue (FIFO) until a slot frees. Workers are reaped after an idle timeout.
- **Bounded and configurable**: hard cap `TASK_WORKER_MAX` (graceful degradation: 0 disables the pool — the always-runs guarantee; **unset defaults to 0** so existing deployments and the e2e harness keep serial semantics until the knob is turned up — the local demo machine sets 3 in `.env`), idle reap after 5 minutes.
- **Worker lifecycle observability**: worker spawn/reap/busy/idle changes are broadcast to connected clients (the existing event surface gains pool-state fields), so /tasks rows and ops views can see where executions run.
- **Interaction with the aggregator**: the summary injection (②) is unchanged — workers only widen where child tasks execute; a fan-out's children may now finish concurrently, and the aggregation still fires once after the last finisher.

Non-goals: cross-cell or A2A targets (target stays `persona`); workers serving interactive chat (primary only); dynamic cap resizing without restart; MC bridge (④); per-task model overrides on workers (workers inherit the cell's model configuration); UI redesign beyond pool-state visibility fields.

## Capabilities

### New Capabilities

- `worker-pool`: worker slot lifecycle — spawn-on-demand with persona affinity, bounded cap, per-worker homes, idle reap, graceful degradation at cap 0, dispatch policy (primary stays interactive when workers exist), and pool-state broadcasts.

### Modified Capabilities

- `task-engine`: the execution-slot requirement gains the worker dispatch rule — executions MAY run on worker slots per the pool's policy; the serial primary-slot policy applies when no worker is available (cap 0 or pool saturated); queue-behind-turn semantics on the primary are unchanged for serial mode.
- `tenant-cell-runtime`: the cell encapsulation requirement is restated — one interactive runtime plus an optional bounded pool of task workers, all living inside the cell's data directory; the isolation boundary (nothing readable/writable across cells) is unchanged.

## Impact

- **Code**: `task-engine.js` (dispatch policy hook: worker-pool registers as the slot provider), new `server/worker-slots.js` (spawn/reap/affinity/cap; rides the serialized queue discipline), `dsh-bridge.js` consumed as-is (multi-instance), `server/dsh-events.js` gains per-bridge event demux (today it assumes one bridge), worker-side turn collection reuses the cron-runner collector contract, pool-state fields on the existing broadcast.
- **Deploy**: fd-prod sets `TASK_WORKER_MAX=0` until node capacity allows (4GB OOM history); local/desktop gets the default 3. DEPLOY.md gains the knob.
- **Risks carried in**: fresh-home bootstrap must go through dsh-profile composition (not a new path); concurrent SQLite writes are WAL-safe but the write chain stays single-process; concurrent model turns multiply gateway load (rehearsal budget note).
- **Decisions recorded**: ADR 0005 (execution slots, serial default); glossary 执行槽/工作槽 in `CONTEXT.md`.
