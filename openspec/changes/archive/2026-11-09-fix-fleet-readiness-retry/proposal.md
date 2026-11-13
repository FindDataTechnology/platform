# Proposal — fix-fleet-readiness-retry

## Why

A fleet round whose runtime is not ready waits a fixed bound (120s), then records
`skipped` — and a skipped patrol is **gone**: nothing retries it, the next slot is
the next scheduled occurrence, and for a daily/定时 post that means the day's work
never happened. The existing requirement says this out loud ("SHALL NOT 由本机制
发起任何重试（下一排定周期自然再来）"), which was a defensible trade when the only
cause was a cold cell.

It is no longer only a cold cell. **Delivering a credential change restarts the
dsh child** (`[mcp-delivery] credential change: runtime child restarted with the
fresh patch`). Every "reconnect the market / renew a line token → run now" flow
therefore lands its round inside a restart window, and `isReady()` is false for
that entire window even though the child is *coming back*:

    2026-11-08 live (fleet_1794074224756_jotn1b / job_1794074226355_dawod6):
      turn 5767  status=skipped
                 error="the agent runtime is not ready (waited for fleet round)"
                 startedAt→endedAt = 120.0s   (the whole budget, against a restart)
      four mechanism gates green, run-now returned queued, no turn ever ran

So the platform loses a round in exactly the situation the operator just acted
on. Two things are wrong:

1. The wait cannot tell "down and coming back" (a restart) from "never booted",
   so it spends the entire budget against a child that is about to be ready.
2. A timeout has no recovery ladder: the round is dropped even when the blocker
   is transient by construction.

## What Changes

- `dsh-bridge` exposes `isRestarting()` (it already tracks `#restarting`
  privately for the collision guard) so a readiness gate can observe the restart.
- **Sticky restart grace**: once a restart is observed during the wait, the
  budget is extended by one more window and stays extended — the child still
  needs boot time after the restart finishes, so retracting the grace on the
  last poll would time out exactly where it mattered. Bounded: at most one
  extra window.
- **Retryable signal**: a timeout now reports `retryable: true`, so the caller
  decides rather than guessing.
- **Bounded retry ladder** in the readiness pre-gate: the SAME round is
  re-enqueued after 30s / 90s / 180s instead of being lost. It is deliberately
  not a new `run now` — the engine's own record re-enters the serialized queue,
  so the retry continues the round (same prompt, same cadence slot). The
  attempt counter lives in a module map keyed by task id (the runner rebinds
  `job` to a copy, so a counter written on it would be lost) and clears when a
  round actually starts or the ladder is spent.
- **The honest skip survives**: once the ladder is exhausted the outcome is
  exactly today's `skipped` (no ledger, no handoffs, no run instance), so a
  permanently-dead runtime cannot turn into an infinite retry loop.

## 非目标

- No change to the skipped record shape for other sources (lane breaker /
  `model_upstream`) — this change only adds the ladder to the readiness source.
- No change to the turn budget, the preset-parking path, or the lane breaker.
- Not attempting an unbounded wait: a wedged child must still surface as
  `runtime_not_ready`, and the ladder is capped at three attempts.
