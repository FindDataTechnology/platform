## Purpose

Defines the multi-tenant runtime that hosts deployed Agent Services: per-role dsh children composed from the deployment descriptor, the A2A adapter surface, session mapping, child lifecycle policy, and inbound authentication against the registry gateway.

## ADDED Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The child SHALL use the runner's deployment-level default model, and its inference SHALL consume the runner's service quota — never a user's. The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the runner's configured default model, regardless of any cell's model selection

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

The runner SHALL reap a child after a configurable idle interval (default 30 minutes) and cold-start on the next message. The runner SHALL enforce a configurable maximum of concurrent children; a message arriving while at capacity SHALL queue until a slot frees, not fail and not evict a busy child. The runner SHALL expose a health endpoint reporting hosted agents and child states, which the registry's health checks use.

#### Scenario: Idle reap and cold start

- **WHEN** a child has been idle past the interval and a message arrives for its role
- **THEN** the child is cold-started (bounded by the documented start latency) and the message is served

#### Scenario: Capacity queues instead of failing

- **WHEN** all child slots are busy and a message arrives for a role with no child
- **THEN** the message is queued and served when a slot frees, without evicting a busy child

#### Scenario: Health reflects reality

- **WHEN** the registry health-checks a deployed agent whose child is cold-starting
- **THEN** the health endpoint reports the starting state distinctly from serving

### Requirement: Inbound traffic is gateway-authenticated and bypass-proof

The runner SHALL accept A2A traffic only through the registry's reverse proxy: caller authentication and per-agent authorization (`invoke_agent`) are the gateway's `/validate` (the caller's gateway credential rides `X-Authorization`, which the gateway strips at egress), and the deployment's out-of-band A2A credential rides the standard `Authorization` header end-to-end (upstream 1.30.0's egress trust model — the gateway is not a credential broker). The runner SHALL require that credential on every request (card included), so calls lacking it — gateway-proxied or direct — are rejected; the runner SHALL NOT maintain its own caller accounts. Each agent SHALL be served at its own origin (the registry proxy maps `/agent/{path}/**` onto the registered URL's origin — upstream #1734), on a port derived deterministically from the registry path.

#### Scenario: Call without the agent credential is rejected

- **WHEN** a request reaches the agent's origin without the deployment credential in `Authorization` — whether direct or proxied through the gateway
- **THEN** the runner rejects it

#### Scenario: Proxied call with both credentials passes through

- **WHEN** a caller authorized by the gateway (`X-Authorization` validated at `/validate`) presents the deployment credential in `Authorization`
- **THEN** the runner serves the request, with no caller account existing on the runner
