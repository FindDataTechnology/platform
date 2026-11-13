## MODIFIED Requirements

### Requirement: Cluster task execution and aggregation

When a cluster task fires, the engine SHALL resolve the cluster's members (optionally narrowed by `targetAgents`) against the live catalog: a member whose pack is uninstalled, whose entry is not chat/a2a, or whose local persona preset is not ready SHALL be skipped and reported by name. Each runnable member SHALL run the task prompt in its own sub-session `<bound-session>--<agent-id>` titled `<cluster> · <member>`: local persona members through the shared runtime (preset switch, one turn, collected reply) and a2a members as remote turns. Local persona members ALWAYS run sequentially — the runtime hosts one persona at a time; with `allowParallel: true` the a2a members' remote turns overlap the persona loop, and the aggregate SHALL note the sequential degradation when it applies. `timeoutMinutes` bounds each member turn. After the fan-out the runtime SHALL be restored to the preset it had before the task.

When memory federation is enabled on the cell, the engine SHALL, after member resolution and before any member runs, read the cluster's shared memory — the most recent shared pages of the cluster-id project under the owner's memory root — and, when it has content, inject that content as a context block into every member's task prompt; when the project is empty or memory is unreachable no block is injected and the task proceeds unchanged. After the aggregate digest is finalized the engine SHALL write the digest back as a page into the same project; a write failure MUST be recorded without failing the task. Both memory hooks MUST degrade open — with memory unreachable the task's execution, aggregation, and bookkeeping are identical to the memory-off behavior.

The task's bound session SHALL receive the prompt and one aggregate: `all` (default) lists every successful member's output under its name; `first` reports the first successful member's output; `summary` runs one synthesis turn in the bound session under the first successful persona member, fed with every member output, and records that turn exactly once (falling back to the `all` digest with a note when no local member succeeded or the synthesis failed). Members that failed or were skipped SHALL be listed with their reason. The execution SHALL succeed when at least one member succeeded and fail — naming every member's reason — when none did. The cluster's `totalExecutions`/`lastUsedAt` SHALL be updated, and the engine's history entry SHALL record `models: { <member name>: <model id> }` — the model the runtime served each member with (the deployment's lane is the single provider; the record names the model, not a provider layer).

#### Scenario: Sequential fan-out with aggregate

- **WHEN** a two-member cluster task runs with the default policy
- **THEN** each member's reply lands in its own sub-session, the bound session holds the prompt and an aggregate listing both outputs, and the task history records the model each member ran under

#### Scenario: Parallel policy is honest about local personas

- **WHEN** a cluster task with `allowParallel: true` has both local persona members and a2a members
- **THEN** the a2a turns run concurrently with the persona loop, the persona members still run one after another, and the aggregate notes the degradation

#### Scenario: Summary synthesis lands once

- **WHEN** a cluster task completes with `resultAggregation: "summary"` and at least one local member succeeded
- **THEN** the bound session holds the synthesis reply exactly once, led by the first successful persona member

#### Scenario: Partial failure still succeeds

- **WHEN** one member fails and another succeeds
- **THEN** the task succeeds, the aggregate names the failed member and its error, and the successful output is present

#### Scenario: Every member failed

- **WHEN** no member produces output
- **THEN** the task fails with an error naming every member's failure or skip reason

#### Scenario: Shared memory injected into member context

- **WHEN** the cluster-id project under the owner's memory root already holds shared pages and a cluster task fires
- **THEN** every member's task prompt carries the shared-memory context block, and the digest is written back to that project after aggregation

#### Scenario: Memory unreachable degrades open

- **WHEN** the memory service is unreachable and a cluster task fires
- **THEN** the task executes, aggregates, and books exactly as with memory off; the history records the degraded write-back, and the task is not failed for memory reasons
