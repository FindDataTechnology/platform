## MODIFIED Requirements

### Requirement: Dispatch policy is a deployment capability statement

The policy SHALL be selected by `TURN_DISPATCH` with values `legacy`, `queue` (default) and `concurrent`. `legacy` SHALL reproduce the pre-change behavior (session switch cancels the outgoing turn; cross-session prompts dispatch without queueing) and exists solely for rollback. `concurrent` SHALL dispatch web prompts immediately regardless of busyness; per-session event routing, history mirroring and turn close SHALL stay isolated per session. The policy SHALL NOT be user-selectable at runtime.

`concurrent` SHALL be honored only when the deployment sets `DSH_MATRIX_CLOSE_INTERLEAVE=1`. That latch SHALL be set only on a deployment whose runtime has a RECORDED close-under-concurrency verification — either the `dsh-contracts` ⑨b row once it is rebuilt to park the conversation request itself (the 2026-10-19 row parked the session-title side call and carries no evidence; see dsh-matrix/README.md 勘误), or a real-cell experiment protocol (temporary cell on the production engine and real provider; symmetric concurrent rounds asserting overlapping turn lifetimes, and asymmetric rounds asserting one turn closes entirely inside another's in-flight request; no `queued`, no `error`, no wedge, bounded rounds). When the latch is absent the server SHALL fall back to `queue` and log a warning at boot.

The code default SHALL remain `queue` until ⑨b is an honest, green gate; production deployments may enable `concurrent` per this requirement (production did on 2026-10-20: 8 symmetric + 6 asymmetric real-cell rounds, `openspec/changes/flip-turn-dispatch-concurrent/notes/evidence.md`).

#### Scenario: concurrent dispatches both prompts at once
- **WHEN** the policy is `concurrent`, session A's turn is open, and a client sends a prompt for session B
- **THEN** B's prompt SHALL dispatch immediately (user echo → `agent_start`), with no `queued` event
- **AND** each session's viewers SHALL receive only their own session's events through both turns' closes

#### Scenario: one turn closes inside another's open request
- **WHEN** the policy is `concurrent` and B's short turn completes while A's longer turn is still generating
- **THEN** B's viewers SHALL receive `done` for B
- **AND** A's turn SHALL continue unaffected and close with its own `done`

#### Scenario: concurrent refused on an unverified matrix
- **WHEN** the server boots with `TURN_DISPATCH=concurrent` and `DSH_MATRIX_CLOSE_INTERLEAVE` is not `1`
- **THEN** the server SHALL run the `queue` policy and log a warning naming the reason

#### Scenario: legacy restores the old switch behavior
- **WHEN** the server runs with `TURN_DISPATCH=legacy` and a user switches away from a streaming session
- **THEN** the outgoing session's turn SHALL be cancelled as before the change
