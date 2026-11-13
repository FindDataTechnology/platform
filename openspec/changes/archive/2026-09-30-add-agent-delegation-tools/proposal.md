# Proposal: add-agent-delegation-tools

## Why

指挥层 phase ②. The task engine (add-task-engine) exists but is only reachable through the scheduling front-end — a user still cannot say "让股票角色和法律角色分别看看这份新闻" and watch it happen. This change hands the engine to the conversation: every persona can delegate work to other personas through MCP tools, task cards show live progress in the chat, and when all delegated tasks finish, an aggregation turn is injected back into the initiating session with the results. With serial execution (workers arrive in ③), this already delivers the front half of the acceptance picture: 一句话 → 角色拆解 → 分身领任务 → 汇总落回聊天.

## What Changes

- **Delegation tools on every persona** (the agent-scheduling-tools precedent): `delegate_task` (target persona + prompt, fan-out = multiple calls), `task_progress` (live status of the delegating session's tasks), `task_result` (fetch a finished task's output). Tools operate only on the cell they run in; results bind to dedicated child sessions (normal sessions, mission-prefixed titles).
- **Manual trigger kind**: tasks created by delegation carry trigger `manual` — executed immediately by the engine (serial primary-slot policy), no schedule-side states (no pause/expired); re-run keeps working. Schedule semantics are untouched.
- **Task cards in the conversation**: a delegation tool invocation renders as a live task card (target persona, prompt summary, lifecycle state, spent tokens when available), not raw tool output — updating from the existing `cron_*` event surface.
- **Aggregation turn injection**: when every task delegated in one conversation turn is finished (done/failed/interrupted), the engine injects a completion turn into the initiating session — queued behind any busy turn, visibly styled as a task-completion system turn (not a user bubble) — prompting the initiating persona to summarize the children's outcomes.
- **Permission + cost**: delegation goes through the existing permission modes (echo mode asks before dispatch); the tool result and card surface token spend per execution when the runtime reports usage.

Non-goals: worker slots and parallel execution (③ `worker-pool`); the MC bridge and console (④); cross-cell or A2A targets (target stays `{type: "persona"}`); editing/splitting tasks after dispatch; sidebar grouping by mission.

## Capabilities

### New Capabilities

- `agent-delegation-tools`: the delegation MCP tools on all personas, their cell-local binding semantics, task cards in the conversation, and the aggregation-turn injection with its busy-turn queuing.

### Modified Capabilities

- `task-engine`: gains the manual trigger kind — immediate execution on creation/re-run, no schedule-side lifecycle — alongside the schedule trigger; slot dispatch and lifecycle states are unchanged.

## Impact

- **Code**: new `server/delegation-mcp.js` (tool module, the cron-mcp.js pattern), `task-engine.js` (manual trigger enqueue-on-create), `server/agent-session.js`-adjacent injection path for the aggregation turn (queued behind streaming, collector-compatible), `packages/core` (task-card rendering types), web + MP chat surfaces (task card component, locales).
- **Behavioral safety**: scheduling surface and `agent-scheduling-tools` are untouched; manual tasks appear in /tasks as the manual-trigger category (scheduled-tasks-ui already lists all tasks).
- **Sequencing**: builds directly on the archived add-task-engine; slot interface unchanged so ③ is pure increment.
- **Decisions recorded**: ADR 0005 (slots), glossary 委派/任务/工作槽 already in `CONTEXT.md`.
