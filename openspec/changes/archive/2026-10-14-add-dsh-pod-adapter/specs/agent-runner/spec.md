# agent-runner 变更（add-dsh-pod-adapter）

## MODIFIED Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor — OR, under pod mode (add-dsh-pod-adapter), as a member of the one shared pod runtime for its pack deployment (see: Same-pack serving agents may co-host in one pod runtime); in both shapes the member's composition SHALL be driven by the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The child's (member's) inference model SHALL be the descriptor's effective model when it records one, else the runner's deployment-level default model (ADR-0019); and its inference SHALL consume the runner's service quota — never a user's. A change of the descriptor's effective model SHALL take effect by the upgrade-grade drain-and-respawn: in-flight turns drain, the runtime respawns on the new model within the five-minute window, and no other restart channel is introduced (in pod mode the drain-and-respawn unit is the pod). The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the descriptor's effective model, or the runner's deployment default when the descriptor records none — regardless of any cell's model selection

#### Scenario: A model change drains and respawns

- **WHEN** the descriptor's effective model changes
- **THEN** in-flight turns drain (new turns during drain get the explicit drain error, not a hang), the runtime respawns on the new model, and the change is live within the five-minute window

### Requirement: Child lifecycle is bounded and queued

The runner SHALL keep a deployed role's child resident by default — idle reaping is no longer a standalone timer and applies only as warm-zone demotion under the host memory budget (openspec: agent-residency). The runner SHALL enforce a configurable maximum of concurrent children; a message arriving while at capacity SHALL queue until a slot frees, not fail and not evict a busy child. In pod mode the concurrency unit is the pod: the maximum counts pods, and capacity demotion/eviction acts on pods (demoting a pod warm-zones every member). Self-turns fired by the rhythm scheduler SHALL enter the same bounded queue as messages — one queueing discipline for every turn source. The runner SHALL expose a health endpoint reporting hosted agents and child states (resident, warm, starting, paused, serving), which the registry's health checks use; a pod member's state SHALL be derived from its pod's process state plus the member's own turn activity.

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

### Requirement: Turn budgets are enforced with a hard stop

The runner SHALL run every turn of a deployed role — messages, rhythm self-turns, and rollover digests alike — under that role's effective turn budget: the deployment descriptor's budget when present, else the runner's configurable deployment default. When a turn exceeds its budget, the runner SHALL stop the turn and the caller receives a structured error naming the budget bound, and the meter records the turn as a budget kill. In solo mode the stop is the child process: stopped and re-spawns on the role's next touch (the private home's file state and durable agent state survive). In pod mode the stop is cancel-first: the member's session is aborted through the platform bridge's native `session/cancel`; only when the cancel does not converge within a bounded window SHALL the whole pod be hard-stopped as the last resort. A role whose descriptor carries no budget SHALL behave exactly as before this change under the deployment default.

#### Scenario: An over-budget turn is hard-stopped with a named bound

- **WHEN** a role with an effective budget of N minutes runs a turn that exceeds it
- **THEN** the turn fails with a structured error naming the N-minute bound, the child process is stopped, and the next message on that role cold-starts a fresh child

#### Scenario: Durable state survives the stop

- **WHEN** a budget kill stops a child mid-turn
- **THEN** the role's private home, session storage, and any files the agent wrote remain on disk, and the next conversation continues from them

#### Scenario: Every turn source shares the budget

- **WHEN** a rhythm self-turn or rollover digest exceeds the role's effective budget
- **THEN** it is stopped under the same discipline as a message turn, and the meter records the kill

#### Scenario: No budget means the deployment default

- **WHEN** a deployed role's descriptor carries no budget field
- **THEN** its turns run under the runner's configurable deployment default, unchanged in behavior from before this change

#### Scenario: A pod member's over-budget turn cancels the member, not the pod

- **WHEN** a pod-hosted member's turn exceeds its effective budget
- **THEN** the member's session is cancelled through the bridge, the turn settles with the structured budget error, the meter records the budget kill, and the pod keeps serving the member's and its siblings' next turns

## ADDED Requirements

### Requirement: Same-pack serving agents may co-host in one pod runtime

Under pod mode (opt-in runner configuration, default off — solo behavior byte-identical), the runner MAY host the serving agents of one pack deployment together in a single shared dsh process (a pod): one private runtime home materialized from the pack's member descriptors, one process, N member agents. Co-hosting SHALL be gated by eligibility: every member shares the deployment's billing key (or none declares one), same-named deployment secrets reference the same value, and the runtime's platform bridge reports the live methods pod serving requires (`preset/set`, `model/set`, `session/cancel`); a pack that fails any gate SHALL fall back to solo children per member — eligibility never refuses a deployment. Agents of different packs (or owners) SHALL NEVER co-host. Each member's persona preset, model, tool face, and turn budget SHALL be per-member and SHALL NOT weaken by co-hosting: sessions are namespaced per member inside the shared home so one member's conversation never lands in another's history, and the member's effective tool allowlist SHALL be its exact per-role face (the process-level guard carries the union; the per-member restrict narrows to the member's own allowlist at session composition). An external-context reap SHALL still find member-prefixed `srv-wx-*` sessions.

#### Scenario: Pod composition from the pack's descriptors

- **WHEN** the runner cold-starts a pod for a pack whose two serving agents declare different personas and models
- **THEN** one process hosts both members; each member's sessions compose with that member's persona preset and run on that member's effective model

#### Scenario: An ineligible pack falls back to solo

- **WHEN** a pack's serving agents carry two distinct billing key references, or the spawned runtime lacks a required live method
- **THEN** each member serves from its own dedicated child exactly as in solo mode, and the deployment never fails for pod ineligibility

#### Scenario: Cross-pack isolation is absolute

- **WHEN** the runner groups entries into pods
- **THEN** co-hosted members always share one pack deployment; no process, home, credential file, or MCP sidecar is ever shared across packs or owners

#### Scenario: Sessions never cross members

- **WHEN** two members of a pod each receive a message on their own context
- **THEN** each turn's history contains only that member's conversation, and the shared home's session storage keeps their (namespaced) sessions distinct

#### Scenario: Any member's descriptor change drains the pod

- **WHEN** one member's descriptor changes (upgrade, model, tools, secrets, notify binding)
- **THEN** in-flight turns across the pod drain, the pod is rebuilt with the new composition, and member sessions resume from disk state after the rebuild

#### Scenario: Pod turns obey the pod in-flight discipline

- **WHEN** a pod's configured in-flight turn limit is reached and another turn arrives for any member
- **THEN** the turn queues under the existing bounded-queue discipline and is served when a lane frees — it never fails for concurrency and never preempts an in-flight turn
