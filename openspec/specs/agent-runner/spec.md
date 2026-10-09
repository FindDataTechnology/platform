# agent-runner Specification

## Purpose
Defines the multi-tenant runtime that hosts deployed Agent Services: per-role dsh children composed from the deployment descriptor, the A2A adapter surface, session mapping, child lifecycle policy, and inbound authentication against the registry gateway.

## Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The child's inference model SHALL be the descriptor's effective model when it records one, else the runner's deployment-level default model (ADR-0019); and its inference SHALL consume the runner's service quota — never a user's. A change of the descriptor's effective model SHALL take effect by the upgrade-grade drain-and-respawn: in-flight turns drain, the child respawns on the new model within the five-minute window, and no other restart channel is introduced. The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the descriptor's effective model, or the runner's deployment default when the descriptor records none — regardless of any cell's model selection

#### Scenario: A model change drains and respawns

- **WHEN** the descriptor's effective model changes
- **THEN** in-flight turns drain (new turns during drain get the explicit drain error, not a hang), the child respawns on the new model, and the change is live within the five-minute window

### Requirement: A2A adapter surface

Each hosted Agent Service SHALL serve its AgentCard at `/.well-known/agent-card.json` and accept JSON-RPC `message/send` (synchronous) and `message/stream` (SSE streaming) at its route. Responses SHALL carry text parts only in v1; file or chart outputs SHALL NOT be emitted as A2A artifacts. The served card SHALL match the card registered for the agent in the registry. Unsupported A2A methods SHALL return the protocol's method-not-found error, not crash the child.

#### Scenario: Card is discoverable

- **WHEN** a caller fetches the well-known card path of a hosted agent
- **THEN** the response is a valid AgentCard matching the registry-registered card

#### Scenario: Send returns a completed message

- **WHEN** a caller invokes `message/send` with a text part
- **THEN** the response contains the agent's reply as text parts once the turn completes

#### Scenario: Stream delivers deltas

- **WHEN** a caller invokes `message/stream` with a text part
- **THEN** SSE events deliver the reply incrementally and terminate when the turn completes

#### Scenario: Unsupported method

- **WHEN** a caller invokes an A2A method the adapter does not implement
- **THEN** a JSON-RPC method-not-found error is returned and the child keeps serving

### Requirement: Context maps one-to-one to a runtime session

Each A2A `contextId` SHALL map to exactly one runtime session on the role's child, so a conversation continues across messages within the same context. When a child is reaped or drained, its sessions end; a caller continuing afterwards SHALL get a fresh session (or an error during drain), never a session that silently mixes histories.

#### Scenario: Continuity within a context

- **WHEN** a caller sends two messages with the same `contextId`
- **THEN** the second turn sees the first turn's history

#### Scenario: Fresh context after reap

- **WHEN** a child is idle-reaped and the caller sends a message with a new `contextId`
- **THEN** the runner cold-starts a child and the conversation starts fresh

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

### Requirement: Inbound traffic is gateway-authenticated and bypass-proof

The runner SHALL accept A2A traffic only through the registry's reverse proxy: caller authentication and per-agent authorization (`invoke_agent`) are the gateway's `/validate` (the caller's gateway credential rides `X-Authorization`, which the gateway strips at egress), and the deployment's out-of-band A2A credential rides the standard `Authorization` header end-to-end (upstream 1.30.0's egress trust model — the gateway is not a credential broker). The runner SHALL require that credential on every request (card included), so calls lacking it — gateway-proxied or direct — are rejected; the runner SHALL NOT maintain its own caller accounts. Each agent SHALL be served at its own origin (the registry proxy maps `/agent/{path}/**` onto the registered URL's origin — upstream #1734), on a port derived deterministically from the registry path.

#### Scenario: Call without the agent credential is rejected

- **WHEN** a request reaches the agent's origin without the deployment credential in `Authorization` — whether direct or proxied through the gateway
- **THEN** the runner rejects it

#### Scenario: Proxied call with both credentials passes through

- **WHEN** a caller authorized by the gateway (`X-Authorization` validated at `/validate`) presents the deployment credential in `Authorization`
- **THEN** the runner serves the request, with no caller account existing on the runner

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

### Requirement: Facade-originated external contexts are idle-reaped

The runner SHALL reclaim runtime sessions under external contexts — the context namespace the facade derives for external callers — after a configurable idle period (default 24 hours), freeing session storage. Rhythm day-sessions and registry-path (internal) contexts SHALL NOT be subject to this reap. A message arriving on a reaped external context SHALL continue as a fresh conversation on that context — never an error, never a silently mixed history. Durable state across external requests belongs in the agent's own files, not session history.

#### Scenario: An idle external context is reaped silently

- **WHEN** an external context has been idle past the configured window and a message later arrives on it
- **THEN** the turn runs on a fresh session for that context, without error

#### Scenario: Internal and rhythm sessions are untouched

- **WHEN** the reap pass runs
- **THEN** rhythm day-sessions and internal (registry-path) contexts remain resident and unaffected

### Requirement: Turn budgets are enforced with a hard stop

The runner SHALL run every turn of a deployed role — messages, rhythm self-turns, and rollover digests alike — under that role's effective turn budget: the deployment descriptor's budget when present, else the runner's configurable deployment default. When a turn exceeds its budget, the runner SHALL stop the turn by a hard stop: the child process is stopped and re-spawns on the role's next touch (dsh has no interrupt RPC — ADR-0014 ④; the private home's file state and durable agent state survive), the caller receives a structured error naming the budget bound, and the meter records the turn as a budget kill. A role whose descriptor carries no budget SHALL behave exactly as before this change under the deployment default.

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

### Requirement: The runner fetches agent secrets over an authenticated channel and pins them into the child

The platform SHALL serve each deployment secret's value to the runner through a gateway route authenticated by the runner's service credential, keyed by the descriptor's secret reference; every fetch SHALL be audit-logged with the reference and agent, never the value. At child composition the runner SHALL pin every declared secret into that agent's private credentials file — the only channel that reaches the child, whose environment is scrubbed — under the secret's declared name. A declared secret whose value cannot be fetched SHALL fail that agent's composition loudly with the missing reference named; the runner SHALL NOT compose the child with a silently partial secret set, and SHALL NOT substitute any fallback value.

#### Scenario: The child receives its declared secrets

- **WHEN** a deployed agent whose descriptor declares two secret references composes
- **THEN** both values land in the child's private credentials file under their declared names, fetched by reference over the service-credential route

#### Scenario: A missing secret fails composition loudly

- **WHEN** a descriptor declares a secret reference the fetch cannot resolve
- **THEN** that agent's child fails to compose with the missing reference named, no partial secret set is installed, and no fallback value is substituted

#### Scenario: Every fetch is audited without the value

- **WHEN** the runner fetches a secret by reference
- **THEN** an audit record names the reference and the agent, and contains no secret material

### Requirement: Deployed children can notify bound channels through the bridge

The platform bridge row each deployed child composes SHALL expose a notification capability: the child may call `bot_notify(event, text[, channel])`, and the runner SHALL execute it with host authority — the platform relay token stays in runner configuration and SHALL never reach the child, whose environment is scrubbed. The deployment MAY bind one named notification channel per serving agent, set by the deployer at deploy time and recorded in the descriptor; a notify call on an unbound deployment SHALL be declined with a structured error naming the missing binding, never silently dropped. The runner SHALL forward accepted calls to the platform's bot relay route addressed to the bound channel (an explicit channel argument, when provided, SHALL name the same deployment-bound channel or be declined), enforce a per-agent notification rate bound, and return the relay's outcome or failure shape to the calling turn.

#### Scenario: A bound deployment delivers a notification

- **WHEN** a child whose deployment binds channel `ops-feishu` calls `bot_notify("ticket_done", "…")`
- **THEN** the runner posts the text to the platform relay addressed to `ops-feishu` with host-held credentials, and the turn receives the relay's success

#### Scenario: An unbound deployment is declined structurally

- **WHEN** a child whose deployment binds no channel calls `bot_notify`
- **THEN** the call is declined with a structured error naming the missing channel binding, and nothing is sent

#### Scenario: The relay token never reaches the child

- **WHEN** a deployed child's composition and environment are inspected
- **THEN** no relay credential is present — the token lives only in runner configuration

#### Scenario: Over-rate notifications are throttled per agent

- **WHEN** a child exceeds its per-agent notification rate bound
- **THEN** excess calls are declined with a rate error before any relay request, and the bound is per agent, not per runner

#### Scenario: Relay failures surface to the turn

- **WHEN** the platform relay refuses or fails a forwarded notification
- **THEN** the calling turn receives the relay's failure shape, and the runner keeps serving

### Requirement: Declared data workspaces are writable under the session sandbox

A deployed role whose descriptor declares an enabled data workspace SHALL run its sessions with a sandbox writable root that covers that data directory: file writes into it succeed under the default `workspace-write` posture without escalation, and the sandbox posture everywhere else is unchanged. Roles without a data-workspace declaration SHALL keep sandbox behavior identical to deployments predating the feature.

#### Scenario: Write inside the data workspace succeeds

- **WHEN** a session on a workspace-declared deployed role writes a file under its data directory
- **THEN** the write succeeds without approval or escalation, and a subsequent read of the same path returns the written content

#### Scenario: Writes outside the writable root remain denied

- **WHEN** the same session attempts a write outside its writable root (for example into the application tree)
- **THEN** the write is refused fail-closed exactly as before this change

#### Scenario: No declaration changes nothing

- **WHEN** a deployed role without a data-workspace declaration runs a turn
- **THEN** its sandbox writable root and launch parameters are indistinguishable from a deployment predating data workspaces

#### Scenario: Quota guardrail posture is unchanged

- **WHEN** a declared data workspace grows past its declared quota
- **THEN** the runner reports the breach (meter line + fleet event) and still neither deletes workspace data nor blocks turns
