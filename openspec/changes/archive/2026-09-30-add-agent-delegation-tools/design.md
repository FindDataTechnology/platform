# Design: add-agent-delegation-tools

## Context

See `proposal.md` (phase ② of the 指挥层). Current state that shapes the approach:

- The task engine (`task-engine.js`) owns records, lifecycle, and the serialized queue; `insertTask` validates targets; `enqueueExecution` guards and chains. Adding a manual trigger is a creation-path concern, not an engine-redesign concern.
- `server/cron-mcp.js` + `server/routes/cron.js` are the precedent for agent-facing task tools: an in-cell MCP child over a loopback REST bridge, already permission-mode-gated by the runtime's tool-call approval path.
- The collector pattern records non-live sessions; the aggregation turn needs the reverse — delivering a prompt INTO a session that may be the live one, which is exactly the cron-runner's prompt path (`waitForIdle → prompt → collector`) aimed at the initiating session.
- Task cards have a precedent in the scheduling job card (`CronToolCard.tsx`, spec agent-scheduling-tools) driven by `cron_*` events.

## Goals / Non-Goals

**Goals:**
- Delegation reachable from any persona's conversation with zero runtime-shape changes (no new processes, no new event channel).
- The aggregation turn as the single new server behavior: one injected prompt per finished fan-out, serialized with everything else.

**Non-Goals (design-level):**
- No parallelism — fan-outs execute serially; ③ adds worker slots behind the same enqueue.
- No new WS message types — task state rides `cron_*`; cards subscribe to the existing store.
- No change to `agent-scheduling-tools` or the scheduling UI beyond what ① already widened.

## Decisions

### D1: Manual trigger = enqueue-on-create in the engine
`insertTask` grows a `trigger` pass-through (validated against `schedule | manual`); manual records carry no cron/when and the delegation path calls a new `engine.createManualTask({ target, prompt, sessionTitle, mission })` that inserts and immediately `enqueueExecution`s. Guard interplay: manual tasks never have schedule-side states, so the `scheduleSideBlocked` check is vacuously false for them.
*Alternative*: a delegation-specific queue bypassing the engine — rejected: two queues, one runtime; the engine's serialization is the invariant that keeps the single dsh runtime honest.

### D2: Tools live in a `delegation-mcp.js` child, REST-bridged like cron-mcp
`server/delegation-mcp.js` (stdio MCP child) exposes `delegate_task`, `task_progress`, `task_result` against `server/routes/delegation.js` (loopback REST, the cron-bridge pattern). The runtime's existing tool-approval (permission modes) gates `delegate_task` — no new permission surface. The child knows the current preset (REST passes it, as cron's internal binding does) to reject self-delegation.
*Alternative*: tools inside the web process via direct function calls — rejected: MCP is the established shape for persona-facing tools (skills/tools parity, manifest scoping via resource sets).

### D3: Fan-out bookkeeping lives on the conversation turn
A delegation records `(initiatingSessionId, turnRef, [taskIds])` in memory (a Map on the engine context, persisted opportunistically with the task records). When every id in a group reaches a terminal state, the engine schedules exactly one aggregation turn into the initiating session: `waitForIdle` → record a system-authored user message (visibly styled, kind `task_summary`, listing result references) → prompt the runtime → collector persists the persona's summary. Restart repair: groups with unfinished tasks re-arm their waiter at load; already-terminal groups inject once at load (queued), never twice.
*Alternative*: the persona polls with `task_progress` and summarizes on its own initiative — rejected: the acceptance picture is the summary landing without anyone asking again; polling makes the picture depend on the model's diligence.

### D4: Task cards extend the job-card pattern
`packages/core` marks delegation tool invocations with the task id; web renders a `TaskCard` (sibling of `CronToolCard`) subscribing to the cron store row for live state + tokens (usage recorded on the history entry when the runtime reports it). MP renders the same card shape in its tool-usage rendering, degraded to state + persona when layout-constrained.
*Alternative*: a dedicated delegation event channel — rejected: `cron_*` already carries lifecycle for every task; a second channel would need merging in every store.

### D5: Child sessions are normal sessions with mission-prefixed titles
Delegation tasks mint `sessionId = task-${id}` (engine pattern), title `[委派] <prompt summary>` via the existing title derivation. They appear in the session list and /tasks like any task — no grouping (deferred per R2).

## Risks / Trade-offs

- [Aggregation turn races a user's next prompt] → the injection queues through the same serialized chain as tasks (`waitForIdle` before record+prompt); a user turn that started first simply delays it one turn.
- [Delegation loop — persona delegates to itself transitively] → self-delegation is rejected directly; depth is bounded by fan-out being persona-to-persona within one cell and each child running in its own session; a cycle guard (mission-chain depth cap of 3) is cheap to add if observed.
- [In-memory fan-out groups lost on restart] → terminal groups re-inject once at load; unfinished groups re-arm — no double injection (the injected marker persists with the task group record).
- [Token spend unavailable on some models] → card omits the spend line when usage is absent; never blocks the card.

## Migration Plan

1. Engine: `trigger` validation + `createManualTask` (additive; existing records unaffected — they all say `schedule`).
2. REST + MCP child + manifest/tool availability (resource sets already scope per-persona tools).
3. Fan-out groups + injection path.
4. Cards (web, then MP) + locales.
5. Rollback: any step is inert without the next — delegation tools simply don't appear if the MCP child is absent.

## Open Questions

- Whether `task_result` needs pagination for very long outputs — defer until a real delegation overflows the tool-result budget; the summary turn already carries the essentials.
