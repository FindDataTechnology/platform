# Design: add-mission-control-bridge

## Context

See `proposal.md` (phase ④; R2 Q9/Q11 decisions). Facts that shape the approach:

- The engine's manual trigger already provides everything the bridge needs: create-with-immediate-dispatch, dedicated session, lifecycle, re-run, worker/primary slot policy. The bridge is a pure front-end — the same position cron.js (schedules) and delegation (conversations) hold.
- MC is alpha with a documented REST flow (register → `GET /api/tasks/queue?agent=` → submit result); shapes may churn. The bridge pins those three endpoints and treats drift as a claim error (backoff + log).
- Precedent for outbound polling modules: the registry bridge (initRegistryBridge) — background loops, never boot-blocking, degrade silently.

## Goals / Non-Goals

**Goals:**
- Outbound-only enrollment; MC tasks indistinguishable from local manual tasks on the cell.
- Idempotent claim (restart mid-claim safe) and at-least-once result posting.
- Zero behavior change when the env is absent.

**Non-Goals:**
- MC-side configuration (roles/evals/spend views), live session streaming, user-cell enrollment, the instance deployment itself (runbook only).

## Decisions

### D1: The bridge is a polling front-end over the engine's manual trigger
`server/mc-bridge.js` owns: registration + heartbeat (30s), queue poll (5s, backoff to 5min on error), claim→`engine.createManualTask({ persona, prompt, origin })`, and an `addOnFinished` subscriber that posts results. `origin: { mc: <consoleTaskId> }` rides the task record (persisted) — the idempotency key and the result-routing key. The dispatcher/worker pool serve it like any manual task.
*Alternative*: a dedicated `mc` trigger kind — rejected: the engine's trigger registry would grow a kind with no distinct execution semantics; manual is exactly "created on demand, runs now".

### D2: Claim mapping convention
MC tasks are created by the operator with the convention `title: <persona preset id>` and `description: <prompt>`. The bridge validates the persona against the live roster (`ctx.getAgentPresets`) before creating the cell task — unknown → POST a structured failure to the console, no cell task. (The roster check is the only persona-name coupling; a roster refresh changes available targets without bridge changes.)

### D3: MC endpoint pinning and result posting
Fixed paths: `POST /api/agents/register`, `GET /api/tasks/queue?agent=<name>`, `POST /api/tasks/<id>/result` (submit). Auth: `Authorization: Bearer <MC_API_KEY>`. Result payload: `{ status, output, error, usage }` derived from the task's terminal state and its session's last assistant text. Failed posts retry on the next poll cycle (the pending-post set is derived from records with `origin.mc` whose terminal state lacks a `mcReportedAt` marker — persisted, so restarts resume posting).
*Alternative*: configurable path templates — rejected until a real MC version actually breaks a path; one constant each is easier to patch knowingly.

### D4: Backoff and liveness
A single loop state machine: poll → on error double the interval (cap 5min), on success reset to 5s; heartbeat rides the same loop every 6th tick. All timers unref'd; attach is synchronous and never awaited at boot (the registry-bridge pattern).

### D5: e2e against a stub console
MC's alpha API and external deployment make live-MC testing a deployment activity. The e2e boots a self-hosted **stub console** (in-test HTTP server implementing the three pinned endpoints) plus a self-booted cell with the bridge enabled: register → queue a task → claim → execute (dead LLM → failed) → result posted → unknown-persona rejection → restart idempotency is unit-level (engine record `origin.mc` reuse). First live-MC verification is a runbook checklist item at deployment.

## Risks / Trade-offs

- [MC API drift] → claim fails softly (backoff + log); the runbook's first-deploy checklist re-verifies the three endpoints against the deployed MC version.
- [Duplicate dispatch if MC re-queues after result-post loss] → result posting is at-least-once with `mcReportedAt`; a re-seen id that already has a cell task is never re-created (claim idempotency), worst case the console sees a late result.
- [Polling load at fleet scale] → one request per cell per 5s; acceptable at owner+demo scale; revisit at real fleet size.

## Migration Plan

1. Merge (inert by default; no deploy action).
2. Deploy MC instance per runbook (tailnet host, `MC_ALLOWED_HOSTS`, compose).
3. Enroll operator/demo cells via env; run the checklist (register/queue/result round trip).
4. Rollback: unset `MC_BRIDGE` — zero residue beyond finished tasks in /tasks history.

## Open Questions

- The exact register/submit payload field names on the deployed MC version — resolved at first deployment (checklist item), adapter constants if needed.
