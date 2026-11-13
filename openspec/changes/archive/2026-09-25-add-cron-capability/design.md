## Context

The cron engine (`cron.js`) already runs inside each cell: node-schedule timers, atomic `jobs.json` persistence, a serialized execution queue, graceful shutdown, and gateway-side keep-alive for cron-holding cells (`gateway/spawner.js`). The WS surface (`server/ws.js`) already handles `cron_add/remove/pause/resume/list/run` and `core` already types the `cron_*` events — `chat-store` deliberately ignores them, expecting owning views to subscribe.

Constraints that shape the design:

- One dsh child process per cell, one persona preset at a time. `switchPresetToInner` (server/agent-session.js:587) switches presets by **restarting the runtime**, guarded by `ctx.isStreaming` and serialized by `ctx.runExclusiveRuntimeMutation`. Sessions are durable on the dsh side; the preset-bridge already implements probe-then-resume (resume must precede create).
- `dshBridge.prompt(sessionId, blocks)` (dsh-bridge.js:253) takes an explicit session id; dsh notifications carry `sessionId` and `server/dsh-events.js` already routes by it. The current cron wiring (`ctx.session.prompt`) ignores both facts and prompts the live session.
- `chatHistory.listSessions()` already returns `updatedAt` per session — enough for client-side unread derivation with no server changes.
- Gateway `mp-auth.js` already holds the MP appid/secret pair; subscribe-message sending uses the same credentials.
- Local MCP servers are an established pattern (`mcp.json` → `server/library-mcp.js`).

## Goals / Non-Goals

**Goals:**

- Job model with `(preset, sessionId, tz)` binding and a firing pipeline that is correct under preset drift and busy turns.
- One scheduled-task UI surface per client (web, miniprogram) plus job cards for agent-created tasks, all fed by the existing `cron_*` events.
- Agent self-scheduling via a local MCP server available to every preset.
- Deterministic downtime semantics (skip + record, never catch up) and client-side unread.

**Non-Goals:**

- Cross-cell or platform-level scheduling: jobs stay in their cell; the gateway only keeps cron-holding cells alive (existing behavior, unchanged).
- Running a second parallel dsh child per job to avoid preset restarts — concurrent children over shared session storage is the exact class of bug the probe-then-resume fix addressed. Not attempted.
- WeChat subscribe-message delivery in v1 (spec'd as the envelope; implementation deferred — see tasks).
- Calendar/natural-language schedule parsing beyond the preset frequencies plus raw cron in the creation form.

## Decisions

### D1. Job model: extend the persisted job record, keep `jobs.json`

Job gains `preset`, `sessionId`, `sessionTitle`, `tz`, `missed` counters, and `status` values `expired`/`missed`. The store stays the single `jobs.json` with atomic writes — per-job files would add partitioning for no consumer. Existing records lack the new fields: load-time backfill treats a missing `preset` as the cell's current persisted preset preference, missing `sessionId` triggers dedicated-session creation on first fire, missing `tz` falls back to cell-local evaluation (spec'd as legacy behavior).

*Alternative:* a per-job session directory mirroring job lifecycle. Rejected — sessions already live in the session store; the job only needs the pointer.

### D2. Firing pipeline: queue → switch → resume → prompt, staying on the job's preset

When a job comes due:

1. Enqueue onto the existing execution queue (turns the old skip-if-streaming into wait-for-turn; a streaming check loops or re-arms on the turn-done signal rather than dropping the run).
2. Under `ctx.runExclusiveRuntimeMutation`: if `ctx.currentPreset !== job.preset`, `dshBridge.restart({ agentPreset: job.preset })` — the exact call `switchPresetToInner` makes, reusing its guard and preference persistence.
3. Probe-then-resume the job's `sessionId` (create the dedicated session on first fire; title from the job).
4. `dshBridge.prompt(job.sessionId, blocks)` and stream as a normal turn; `chatHistory.recordMessage` lands under that session id.

No auto-restore afterwards: the runtime stays on the job's preset and the existing `agent_changed` broadcast keeps clients truthful. Doubling the restarts to restore Q (and racing the user's next action) buys little — the user's next morning surface *is* the agent they tasked.

*Alternative considered:* fire under whatever preset is live. Rejected — persona drift makes "daily report by FD" non-deterministic. *Alternative considered:* defer until preset matches. Rejected — a job the user must manually unblock is a job that silently never runs.

### D3. Timezone: IANA id on the job, evaluated by the scheduler

node-schedule ^2 accepts `tz` in the rule options; jobs store the IANA id verbatim and pass it through. Clients send `Intl.DateTimeFormat().resolvedOptions().timeZone` at creation; `nextRun` is computed and displayed in the job's tz. The MCP tool takes `tz` as an optional parameter (agents relay the client-provided zone; absent → cell-local, stated in the tool result).

*Alternative:* store UTC-offset minutes. Rejected — DST handling moves into our code for no gain.

### D4. Missed runs: skip and record, never catch up

On load and on each fire, compare `lastRun` against the cron occurrence window; occurrences entirely covered by downtime increment a `missed` counter and emit a history entry marked `missed`. Catch-up was rejected: replaying a stock summary twice at 9:05 is worse than once, and unbounded catch-up after long outages is a self-DoS on a 4GB node.

### D5. Tool exposure: local MCP server, not preset patches

`server/cron-mcp.js` (patterned on `library-mcp.js`) registered in `mcp.json`, exposing `cron_create / cron_list / cron_pause / cron_delete`. Every preset sees the tools with zero per-preset patching; the server calls the same engine functions `ws.js` does, so queueing/binding semantics cannot be bypassed. Job-card rendering rides the existing tool-use rendering path keyed on the tool name.

*Alternative:* dsh-side patch files (the `*PatchPath` mechanism). Rejected — patches are per-runtime concerns (tool-search overlay); a cell-local service belongs in the established MCP slot.

### D6. Client state: a dedicated jobs store per client, chat-store keeps ignoring `cron_*`

A small `useJobsStore` (web) / equivalent (miniapp) subscribes to `cron_*` events, issues `cron_list` on connect, and backs the management pages and job cards. `chat-store`'s ignore list stays as-is — the comment there already describes this contract ("owning views subscribe themselves").

### D7. Unread: client-side last-seen vs `updatedAt`

Each client persists `lastSeen[sessionId]` on session open; unread = `updatedAt > lastSeen`. No server read-tracking, no new events. Badge surfaces: session-list rows (both clients), miniprogram history entry point, scheduled-task page rows.

### D8. Subscribe-message envelope: v1 in-app only, v2 behind a task flag

The spec'd WeChat leg (consent request at creation, quota check, silent degrade) is a self-contained later increment: template registration + gateway send path + a consent ledger. Nothing in v1's data model precludes it; `jobs.json` already carries what a message needs.

## Risks / Trade-offs

- [Preset restart during a job storm] Several jobs on different presets firing close together causes repeated runtime restarts. → The serialized queue plus run-exclusive mutation already space them out; jobs on the same preset batch naturally. Acceptable at expected job volumes.
- [Restart kills an in-flight user turn] The queue waits for the current turn, but a user prompt racing the restart window can be interrupted. → Same blast radius as a manual agent switch today (streaming-guarded); the job retries on the next tick rather than being lost.
- [node-schedule `tz` correctness] If the installed minor doesn't honor `tz` as expected, schedules drift to server time. → Verify with a pinned unit test during implementation; fall back to evaluating the rule via cron-parser with `currentDate` in the job's tz if needed.
- [MP review for subscribe templates] WeChat template approval is outside our control and may lag. → v2 is envelope-only; in-app unread is always the floor.
- [Backfill ambiguity] Legacy jobs' intended preset is unknowable; defaulting to the persisted preference may surprise. → One-time, observable in the UI (preset shown per job), user-editable by recreating the job; migration is additive, never destructive.

## Migration Plan

1. Ship engine + backfill first (old records keep working; firing semantics improve in place). `jobs.json` grows new fields — no format break, rollback simply ignores them.
2. Ship clients and MCP server behind the same deploy; the WS surface is unchanged so partial rollout (engine before clients) is safe.
3. Rollback: revert the image; persisted jobs re-load under the previous semantics (unknown fields ignored). Dedicated sessions created for jobs remain ordinary sessions — harmless orphans if the change is reverted.

## Open Questions

- Exact MP entry placement for the scheduled-task page (history-page sibling vs. settings entry) — decided at UI implementation; both are one navigation hop from the current shell.
- Whether the miniprogram job card renders inside `TurnView` as a collapsed activity group (consistent with the master-fold design) or a distinct card component — visual decision, no spec impact.
