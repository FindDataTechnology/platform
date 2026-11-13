## 1. Engine — job model and persistence

- [x] 1.1 Extend the job record in `cron.js` with `preset`, `sessionId`, `sessionTitle`, `tz`, and `missed` fields; backfill on load (missing preset → persisted preference, missing tz → cell-local); verify a `jobs.json` from the current format loads and reschedules unchanged apart from backfilled fields
- [x] 1.2 Mark expired one-shots (`status: "expired"`) and record `missed` markers for downtime-covered occurrences at load and at fire time; verify with a unit-style harness: restart with a past-due one-shot → expired without executing; restart across one daily occurrence → no catch-up run, `missed` incremented
- [x] 1.3 Keep `atomicWriteJson` serialization of the new fields and history pruning bounds; verify add/pause/resume/remove round-trips still persist and reload

## 2. Engine — timezone-aware scheduling

- [x] 2.1 Pass the job's IANA `tz` into the node-schedule rule; add a pinned test asserting `0 9 * * *` + `Asia/Shanghai` fires at 09:00 CST on a UTC host (if node-schedule ignores `tz`, evaluate via cron-parser with a tz-shifted reference date per design D3) and verify the fallback test passes
- [x] 2.2 Compute `nextRun` in the job's timezone and expose `tz` on the job payload in `cron_list`/`cron_status`; verify the WS reply for a Shanghai-tz job shows a next-run string consistent with 09:00 CST

## 3. Engine — firing pipeline (binding, queue, preset switch)

- [x] 3.1 Replace skip-if-streaming with wait-for-turn: a due job re-arms on turn completion instead of dropping; verify via a scripted cell (mp-stub or e2e seam) that a job due mid-stream executes exactly once after the turn ends
- [x] 3.2 Implement the firing sequence under `ctx.runExclusiveRuntimeMutation`: preset mismatch → `dshBridge.restart({ agentPreset: job.preset })` (mirroring `switchPresetToInner`, including preference persistence and `agent_changed` broadcast), probe-then-resume `job.sessionId` (create the dedicated titled session on first fire), then `dshBridge.prompt(job.sessionId, ...)`; verify a job bound to preset P fires into its own session while runtime sat on Q, and the runtime remains on P afterwards
- [x] 3.3 Record the cron turn under the bound session in chat history and confirm streaming events route by the notification's `sessionId` (server/dsh-events.js) so a connected client viewing another session is unaffected; verify the turn lands under the job's session in the sessions list
- [x] 3.4 Accept `preset`, `tz` on `cron_add` in `server/ws.js` (dedicated session created on first fire); keep all existing `cron_*` message/event names unchanged; verify the e2e seam round-trips the new fields without breaking existing cron specs

## 4. Agent scheduling tools (MCP)

- [x] 4.1 Create `server/cron-mcp.js` (patterned on `server/library-mcp.js`) exposing `cron_create / cron_list / cron_pause / cron_delete` over the engine's own functions; register in `mcp.json`; verify `tools/list` from a live cell shows all four tools on every preset
- [x] 4.2 Validate tool inputs (cron syntax, future one-shot time) returning structured errors; verify an invalid expression returns an error payload and creates no job
- [x] 4.3 Return confirmation payloads (id, human-readable schedule, applied tz, session title) from `cron_create`; verify against the fired job record

## 5. Web client

- [x] 5.1 Add a jobs store subscribing to `cron_*` events with `cron_list` on connect (chat-store ignore list untouched); verify live status updates without refresh against a stub cell
- [x] 5.2 Build the scheduled-task management page (list + actions pause/resume/delete/run-now with confirmation on delete); verify each action round-trips to the engine and reconciles with broadcasts
- [x] 5.3 Build the creation form (preset frequencies, custom cron with validation, agent picker from `presets`, one-shot datetime, prompt, client-default tz) and the output link to the job's session; verify creating a daily job shows it with next-run in the chosen tz
- [x] 5.4 Render schedule human-text (daily/weekly/custom) in the active locale across the five locale files; verify locale switch updates the phrasing
- [x] 5.5 Render agent-created tasks as job cards (schedule + tz + agent + status, pause/delete affordances) on the tool-use rendering path keyed by tool name; verify a `cron_create` invocation renders as a card, not raw output

## 6. Miniprogram client

- [x] 6.1 Port the jobs store and management page (list + actions) to `miniapp/src`, following the settled layout shell (entry one hop from the history page — exact placement per design open question); verify pages render against the stub-cell harness
- [x] 6.2 Port the creation form (same fields incl. `Intl` timezone capture) and task-output navigation into the job session; verify a created job appears with next-run and opens its session on tap
- [x] 6.3 Render job cards in `TurnView` for scheduling tool invocations (collapsed-activity-group vs distinct card per design open question); verify the card shows schedule/status and its pause affordance reconciles with the jobs store

## 7. Unread indication (both clients)

- [x] 7.1 Implement client-side `lastSeen[sessionId]` persistence on session open and unread derivation against `listSessions`' `updatedAt`; verify a fired job's session shows unread, opening clears it, and restart preserves it
- [x] 7.2 Surface unread badges on session-list rows (web + MP), the MP history entry point, and scheduled-task rows; verify badge visibility per surface in the stub-cell harness

## 8. End-to-end verification

- [x] 8.1 Add `e2e/cron-binding.spec.js`: job bound to a non-active preset fires into its dedicated session behind a streaming turn, runtime ends on the job's preset, `agent_changed` observed; verify the spec passes and re-runs clean against the e2e-seam dist
- [x] 8.2 Add `e2e/cron-ui.spec.js`: management-page smoke (create → list → pause → run-now → output link) on web; verify pass within the existing flake baseline
- [x] 8.3 Add MCP round-trip coverage (create via tool → card renders → pause from card → engine state consistent); verify pass
- [x] 8.4 Run the full e2e suite and confirm no regression beyond the known flake baseline; record results

## 9. Deferred — WeChat subscribe-message envelope (v2, separate change)

Spec'd in `scheduled-task-notifications` as a best-effort envelope over consent; not implemented in this change. v1 ships in-app unread only (sections 5–7). The v2 increment (template registration, gateway send path via existing mp-auth credentials, consent ledger, silent degrade) is a follow-up change.
