# Proposal: add-mission-control-bridge

## Why

指挥层 phase ④ — the operator console. Phases ①–③ made the cell a complete execution unit (engine, delegation, parallel workers); what's missing is commanding a fleet of them. Mission Control (builderz-labs/mission-control, self-hosted, MIT) provides the console surface: task dispatch, run inspection, spend, audit. This change adds the cell-side bridge: the cell registers as ONE MC agent (agent ↔ cell, never persona — R2 decision), polls its queue, runs claimed tasks through the task engine, and posts outcomes back. The bridge is **default-off** and v1 enrollment is limited to the operator's own cell and demo cells (R2 Q9); user cells never register.

## What Changes

- **MC bridge module** (`server/mc-bridge.js`): enabled only when `MC_BRIDGE=1` plus `MC_URL`/`MC_API_KEY`; registers the cell as an MC agent (deployment-named), heartbeats, polls its task queue on a short interval with error backoff, and maps each claimed MC task to an engine **manual-trigger task** carrying `{persona, prompt}` — executed by the engine's normal dispatch (serial or worker pool, whichever the cell runs).
- **Outcome reporting**: on execution finish, the bridge posts state/output/error/tokens back to the MC task; an unknown persona fails the MC task with a structured error instead of creating a cell task. Restart mid-claim is idempotent (the MC task id is persisted on the cell task as `origin.mc`; a re-seen MC task never double-creates).
- **No aggregation, no conversation**: MC tasks have no initiating conversation — `initiator` is null, so the delegation aggregator ignores them; they surface in /tasks as manual-trigger tasks with their dedicated sessions, exactly like delegated work.
- **Failure isolation**: MC unreachable → the bridge backs off and retries; chat, delegation, scheduling, and workers are unaffected; the cell boots with the bridge down.
- **Deployment runbook** (code, not action): DEPLOY.md gains the MC-instance recipe — docker compose on a tailnet-only host (cheap-N), `MC_ALLOWED_HOSTS`, enrollment of the operator/demo cells only, and the first-live verification checklist against MC's documented REST flow (register → queue?agent= → submit result; alpha API, verified at deployment).

Non-goals: enrolling user cells (needs user-consent semantics first); live session streaming to MC (gateway-runtime feature, out of scope); MC-side spend/evals configuration; the actual instance deployment (this change ships the bridge + runbook; deployment is the ops step that follows); persona-level or cross-cell parallel orchestration in MC.

## Capabilities

### New Capabilities

- `mission-control-bridge`: the cell-side MC integration — default-off enrollment, agent↔cell registration and heartbeat, queue polling with backoff, MC-task→manual-task mapping with idempotent claim, outcome posting, and failure isolation.

### Modified Capabilities

(none — the bridge is a new front-end over the engine's existing manual trigger; /tasks already lists manual-trigger tasks.)

## Impact

- **Code**: new `server/mc-bridge.js` (standalone module, one attach line in server.js), `task-engine.js` gains nothing (manual trigger + `origin` passthrough on the record), `.env.example` (`MC_BRIDGE`/`MC_URL`/`MC_API_KEY`/`MC_AGENT_NAME`).
- **Deploy**: default-off everywhere; fd-prod cells unchanged; the operator/demo cells opt in via env once the MC instance exists (tailnet-only per R2 Q11).
- **Risks carried in**: MC is alpha — the bridge pins the three documented endpoints and treats any shape drift as a claim failure (backoff + log), never a cell failure; outbound-only (no inbound port, isolation untouched); polling load is one request per cell per few seconds.
- **Decisions recorded**: 控制台（MC）glossary entry; R2 Q9 (owner/demo cells only) and Q11 (tailnet-only instance).
