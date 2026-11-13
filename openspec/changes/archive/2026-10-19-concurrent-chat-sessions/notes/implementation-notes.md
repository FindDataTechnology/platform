# Implementation notes — concurrent-chat-sessions

Date: 2026-10-19. Code complete for groups 1-5; group 6 (出片 / 真机) not started.

## The bug this change exposed (and fixed)

`server/runtime-bindings.js` wrapped `ctx.finishTurn` as:

```js
ctx.finishTurn = () => { const result = originalFinishTurn?.(); ... };
```

It **dropped the `(outcome, sid)` arguments**. `finishTurn`'s signature is
`(outcome, sid = ctx.dshSessionId)`, so every close went to whatever the global
pointer named *at that moment* — not to the session whose turn actually ended.

Why it was invisible before: the pre-change switch path **cancelled** the
outgoing turn before moving the pointer, so no turn ever outlived a pointer
move. The only way to hit it was a cross-connection `new_session` during a
live turn, which the platform's UX did not produce.

With turns now surviving navigation, it became reachable on the first
"switch away and open a new chat" — the turn's `session.status idle` arrived,
`finishTurn` ran against the NEW session (no open turn → no-op), and the
streaming turn never emitted `done`. Symptom: the turn ran forever, the sidebar
showed `running` indefinitely, and a queued prompt behind it never advanced.

Fix: forward both arguments. Verified by mutation — reverting the fix turns
`scripts/test-turn-dispatch-navigation.mjs` red (2/2), restoring it turns it
green.

## How the diagnosis went wrong (worth recording)

Three separate detours, all from the same mistake — trusting instrumented
liveness probes over a deterministic test:

1. **Truncated logs.** `sed -n '/<marker>/,$p'` cut the same-run log lines that
   landed just *before* the marker, making "the trace never printed" false.
2. **Instrumentation that broke the code under test.** A trace line placed at
   `dsh-events.js:244` referenced `params`, which is only destructured at
   `:320`. That is a TDZ `ReferenceError` inside the event handler: every
   notification threw, got swallowed by the bridge's `try/catch`, and the
   handler never reached `finishTurn`. It made three scenarios fail that had
   been passing minutes earlier.
3. **A test shim that hid the bug.** The first unit repro used a private
   `current` variable for the session manager instead of moving
   `ctx.dshSessionId`. The wrapper's sid default reads *that pointer*, so the
   test passed even with the bug reintroduced — caught only by running the
   mutation.

Rule that came out of it: **reproduce in a unit test with the real
composition-root wiring, then mutation-test the assertion.** A green test that
cannot be made red by reintroducing the bug proves nothing.

## Contract ⑨b measurement

Both turns are now parked mid-request (`[HOLD]` on each, `heldCount() >= 2`
asserted before release) and both reach idle without a cancel: **5/5 PASS** on
the frozen 0.2.0-rc.2 matrix. See `dsh-contract-9b-measurement.md` — the result
contradicts the design premise but is not treated as a refutation (non-
deterministic upstream note, 5 runs, dummy LLM far faster than a real provider).
`TURN_DISPATCH` default stays `queue`.

## Deviations from the task list

- **1.3 spike** targeted 0.2.1-rc.2 as written; changed to measuring the frozen
  matrix, because the frozen matrix is the ship target and ⑨b had to be
  validated as an advisory row there first. The 0.2.1-rc.2 comparison is still
  open.
- **e2e specs own their servers.** `session-navigation-streaming.spec.js` and
  `turn-queue.spec.js` cannot use the shared e2e webServer: its `LLM_BASE_URL`
  is unreachable (`127.0.0.1:9`), so turns close instantly and neither a running
  turn nor a queue is observable. Both now start a server with the slow chaos
  gateway (`e2e/slow-server.js`), which also removed the need for a
  `composer-stop`-style flaky timing dance.

## Verified

- `npm run test:unit` — 1618/1618 (includes 17 dispatcher + 2 navigation tests)
- `npm run typecheck` — clean
- `biome check` over all 23 changed files — clean
- `e2e/turn-queue.spec.js` — 3/3
- `e2e/session-navigation-streaming.spec.js` — 3/3 (the two old assertions,
  "navigation stops the live turn", are now inverted)
- `e2e/{reconnect-resync,session-ownership,session-delete,chat-history}.spec.js` — 11/11
- `npm run dsh:contracts` — 17/17 gating + ⑨b advisory PASS, exit 0
