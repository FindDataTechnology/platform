## Why

The cron engine shipped in 2026-08 (archived `add-browser-use-computer-use-cron-dashboard`) is product-inert: jobs fire into whatever session happens to be active (no session or agent binding), results are visible only in an internal history blob, no client — web or miniprogram — exposes any UI, and the `cron-module` spec never reached the main specs. Meanwhile the product has grown multi-agent (persona presets) and multi-session, which makes the "fires into the current session" behavior actively wrong: a daily 9am report can land in the wrong conversation, under the wrong persona, or be silently skipped while a turn is streaming.

## What Changes

- Jobs become first-class scheduled tasks bound to `(preset, session)`. Firing queues behind the current turn (replacing skip-if-streaming), restarts the cell runtime into the job's preset via the exclusive runtime-mutation path, resumes the bound session, and prompts it. The runtime stays on the job's preset afterwards; UI is informed via the existing `agent_changed` broadcast.
- Scheduling becomes timezone-aware: clients send an IANA timezone at creation, stored per job and applied by the scheduler. Legacy jobs fall back to the cell's local timezone.
- Missed recurring runs while the cell was down are skipped and recorded as `missed` (no catch-up); expired one-shots are marked `expired` at load.
- New client UI (web + miniprogram): scheduled-task management pages (create / pause / resume / delete / run-now), job cards in chat for tasks created by the agent, and in-app unread indication for sessions that gained scheduled output.
- Agents can self-schedule: a local MCP server (`server/cron-mcp.js`, patterned after `library-mcp.js`) exposes `cron_create` / `cron_list` / `cron_pause` / `cron_delete` to every preset.
- Notification phasing: v1 is in-app unread only (client-side last-seen vs the session list's existing `updatedAt`); WeChat subscribe messages are a v2 envelope — credentials already sit in the gateway's mp-auth, but the one-consent-one-send model makes it a best-effort channel that degrades to in-app.
- The `cron-module` capability is revived from the archive into the main specs, extended with the binding, queueing, timezone, and lifecycle behavior above.

## Capabilities

### New Capabilities

- `cron-module`: in-cell scheduling engine — job CRUD and persistence, `(preset, session)` binding, queue-behind-turn firing with preset restart, timezone handling, missed/expired lifecycle, execution history.
- `scheduled-tasks-ui`: web and miniprogram management surfaces — scheduled-task pages, creation form (schedule, timezone, agent, prompt), job status display, unread indication on sessions that received scheduled output.
- `agent-scheduling-tools`: the cron MCP tool surface — tool contracts for create/list/pause/delete, job-card rendering in the conversation, and the confirmation affordances on those cards.
- `scheduled-task-notifications`: how users learn a scheduled task produced output — v1 in-app unread semantics; the v2 WeChat subscribe-message envelope and its degradation rule.

### Modified Capabilities

(none — the wire protocol's `cron_*` events already exist in core types and the gateway's keep-alive for cron-holding cells already works as required; this change only adds consumers and engine behavior behind the existing surface.)

## Impact

- Engine: `cron.js` rework (binding model, firing queue, timezone, lifecycle marking); `server.js` init wiring (`sessionPrompt` becomes a bound-session prompt; probe-then-resume reuse).
- Server surface: `server/ws.js` gains no new event types (existing `cron_*` reused); new `server/cron-mcp.js` plus an `mcp.json` entry.
- Clients: new stores/consumers for `cron_*` events in `packages/core` (chat-store's ignore list stays), scheduled-task pages and job cards in `web/src` and `miniapp/src`.
- Dependencies: none new (node-schedule ^2.1.1 already present and supports the `tz` rule option).
- Specs: `cron-module` lands in main specs for the first time; three sibling capabilities are added alongside.
- Tests: e2e coverage for firing semantics (queue-behind-turn, preset restart), UI smoke, and MCP tool round-trips.
