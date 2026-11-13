# agent-runner Delta

## ADDED Requirements

### Requirement: Delegation depth and concurrency are bounded

The runner SHALL refuse, with an explicit JSON-RPC error naming the bound, any A2A request whose `X-Delegation-Depth` is 3 or greater — a delegation chain is cut at three hops, which breaks every cross-request cycle without global tracking. The runner SHALL additionally bound concurrent delegation-originated turns (depth ≥ 1) per hosted agent to a configurable cap (default 2): over-cap requests queue under the existing bounded-queue discipline, never fail, and never preempt a serving turn.

#### Scenario: Deep chains are refused explicitly

- **WHEN** an A2A request arrives with X-Delegation-Depth: 3
- **THEN** the caller receives an explicit error naming the delegation depth bound, no turn runs, and no child is spawned

#### Scenario: Depth-two chains pass

- **WHEN** an A2A request arrives with X-Delegation-Depth: 2
- **THEN** the request is served normally

#### Scenario: Over-cap delegations queue instead of failing

- **WHEN** delegation-originated turns already fill an agent's concurrency cap and another arrives
- **THEN** the new request queues under the existing queueing discipline and is served when a slot frees
