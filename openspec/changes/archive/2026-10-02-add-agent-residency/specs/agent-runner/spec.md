# agent-runner Delta

## MODIFIED Requirements

### Requirement: Child lifecycle is bounded and queued

The runner SHALL keep a deployed role's child resident by default — idle reaping is no longer a standalone timer and applies only as warm-zone demotion under the host memory budget (openspec: agent-residency). The runner SHALL enforce a configurable maximum of concurrent children; a message arriving while at capacity SHALL queue until a slot frees, not fail and not evict a busy child. Self-turns fired by the rhythm scheduler SHALL enter the same bounded queue as messages — one queueing discipline for every turn source. The runner SHALL expose a health endpoint reporting hosted agents and child states (resident, warm, starting, paused, serving), which the registry's health checks use.

#### Scenario: Idle reap and cold start

- **WHEN** a child has been idle past the former reap interval and the host memory budget is not under pressure
- **THEN** the child stays resident and the next message is served with no cold start; the reap-and-cold-start path exists only for warm-zone re-warm after a budget demotion

#### Scenario: Capacity queues instead of failing

- **WHEN** all child slots are busy and a message arrives for a role with no child
- **THEN** the message is queued and served when a slot frees, without evicting a busy child

#### Scenario: Health reflects reality

- **WHEN** the registry health-checks a deployed agent whose child is cold-starting, warm, or paused
- **THEN** the health endpoint reports each state distinctly from serving

#### Scenario: Self-turns ride the same queue

- **WHEN** a rhythm due fires while all child slots are busy
- **THEN** the self-turn queues behind messages under the same discipline and never preempts a serving turn
