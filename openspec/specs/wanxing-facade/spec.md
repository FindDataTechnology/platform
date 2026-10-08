# wanxing-facade Specification

## Purpose

The external serving front door of the agent platform (ADR-0014): the Wanxing facade authenticates external callers by their own sub2api caller keys, admits them per agent visibility and per-agent allowlists, bounds and deduplicates their traffic, speaks A2A natively at per-agent routes, meters every admitted turn, and settles the caller's key at the boundary. The registry stays internal; internal callers are unaffected.

## Requirements

### Requirement: External callers authenticate with their own sub2api key

The facade SHALL authenticate every external request by the caller's own sub2api API key presented as a bearer credential, validating it through the auth-only liveness probe that exercises the full billing gate (key validity, balance, group, quota) and resolving the caller's identity by the key's holder. Validation results MAY be cached briefly; every admission decision SHALL reflect a probe no older than the configured cache window. The facade SHALL NOT forward, log, or echo the key value anywhere past the request boundary; audit and metering surfaces SHALL carry at most the key's last four characters.

#### Scenario: A valid solvent key is admitted

- **WHEN** a request arrives with a bearer key that passes the liveness probe
- **THEN** the caller is admitted, the caller identity is resolved from the key's holder, and the request proceeds to agent admission

#### Scenario: A dead or insolvent key is refused at the door

- **WHEN** the probe rejects the key (invalid, exhausted consumption window, or insufficient balance)
- **THEN** the request is refused with a structured error naming the billing-gate reason, and no turn starts

#### Scenario: The key never travels past the facade

- **WHEN** the facade forwards an admitted request toward the agent's runtime route
- **THEN** the forwarded request, its logs, and the ledger contain no key material beyond a masked reference

### Requirement: Agent admission follows visibility and per-agent allowlists

The facade SHALL admit an authenticated caller to an agent according to the deployment's visibility: a public agent admits any caller passing the key gate; a private agent admits only callers whose sub2api account is on that agent's caller allowlist, which the deployer manages on the pack deploy surface. A paused or undeployed agent SHALL return its explicit state error rather than a timeout.

#### Scenario: A public agent serves any valid caller

- **WHEN** an authenticated caller invokes a public agent
- **THEN** the request is admitted without any allowlist check

#### Scenario: A private agent serves only allowlisted callers

- **WHEN** an authenticated caller invokes a private agent and the caller's account is not on that agent's allowlist
- **THEN** the request is refused with a not-authorized error naming the agent, and no turn starts

#### Scenario: A paused agent answers with its state

- **WHEN** the target agent is paused
- **THEN** the caller receives an explicit paused error, not a timeout

### Requirement: The facade speaks A2A natively at per-agent routes

The facade SHALL expose each deployed agent at a stable external route derived from the agent's deployment identity, accepting JSON-RPC `message/send` (synchronous final response) and `message/stream` (SSE passthrough) at the agent's base path, serving its AgentCard at the well-known card path without authentication, and listing public agents with card summaries in a public catalog. Unsupported A2A methods SHALL return the protocol's method-not-found error. The facade SHALL forward admitted requests to the agent's runtime route over the platform's internal credentials without altering A2A protocol semantics. Unless the caller supplies a `context_id`, the facade SHALL derive a fresh external context per idempotency key — and the derived identifier SHALL encode the caller's effective context-reap window for that agent (openspec: caller-preferences), so the runner's existing reap pass resolves the per-session TTL from the identifier itself.

#### Scenario: Send returns the agent's completed reply

- **WHEN** an admitted caller invokes `message/send` with a text part
- **THEN** the response returns the agent's reply as text parts once the turn completes

#### Scenario: Stream passes deltas through

- **WHEN** an admitted caller invokes `message/stream`
- **THEN** SSE events pass through incrementally and the stream terminates when the turn completes

#### Scenario: Card and catalog are public

- **WHEN** an unauthenticated party fetches an agent's well-known card path or the agent catalog
- **THEN** public agents' cards and summaries are returned without any credential

#### Scenario: A caller-supplied context continues

- **WHEN** an admitted caller reuses a `context_id` it previously used
- **THEN** the conversation continues on that context's runtime session, subject to idle reaping

#### Scenario: Unsupported method

- **WHEN** an admitted caller invokes an A2A method the facade does not implement
- **THEN** a JSON-RPC method-not-found error is returned and no turn runs

#### Scenario: A derived context carries the caller's reap window

- **WHEN** the facade derives an external context for a caller without a supplied `context_id`
- **THEN** the derived identifier encodes that (caller, agent)'s effective reap window — the caller's preference when set, else the platform default — and a caller-supplied `context_id` passes through unencoded

### Requirement: Idempotency-Key deduplicates turns

The facade SHALL deduplicate `message/send` requests by the `Idempotency-Key` header, scoped per (caller, agent): a repeated key within the retention window returns the recorded first outcome without running another turn, and concurrent duplicates result in exactly one turn.

#### Scenario: A replayed key returns the recorded outcome

- **WHEN** the same (caller, agent, Idempotency-Key) is replayed after the first request completed
- **THEN** the recorded first outcome is returned and no second turn runs

#### Scenario: Concurrent duplicates run one turn

- **WHEN** two requests with the same Idempotency-Key race while the first turn is still running
- **THEN** exactly one turn executes and both callers receive its outcome

### Requirement: External traffic is bounded per caller and agent

The facade SHALL bound in-flight turns to one per (caller, agent): a second concurrent request SHALL be refused with a structured retry-after error, never interleaved into the running turn. The facade SHALL additionally enforce a configurable per-caller rate limit across agents.

#### Scenario: A concurrent second turn is refused with retry-after

- **WHEN** a caller issues a second request to the same agent while its previous turn is still in flight
- **THEN** the request is refused with a retry-after error and the running turn is unaffected

#### Scenario: A burst over the rate limit is throttled

- **WHEN** a caller exceeds the configured request-rate bound
- **THEN** further requests are throttled with a structured rate-limit error

### Requirement: Admitted turns are metered and settled at the boundary

For every admitted external turn the facade SHALL record caller, agent, idempotency key, outcome, and duration in the facade ledger, and on completion SHALL settle the caller's key by duration — rounded up to whole minutes at the platform-configured rate — through an idempotent balance deduction. Settlement failures SHALL retry with backoff; repeated failure or an exhausted balance SHALL suspend the caller, whose next admission is refused until the key passes the billing gate again. A completed turn additionally SHALL fire the caller's turn-completion callback when that (caller, agent) preference is configured (openspec: caller-preferences) — signed, best-effort with bounded retry — without altering the settlement semantics or its ledger records.

#### Scenario: A completed turn settles exactly once

- **WHEN** an admitted turn completes
- **THEN** the caller's balance is deducted once for the minute-rounded duration at the configured rate, and the ledger records the settlement

#### Scenario: Settlement failure retries then suspends

- **WHEN** the balance deduction fails transiently and keeps failing
- **THEN** the facade retries with backoff and suspends the caller after the configured threshold

#### Scenario: A suspended caller is re-admitted after the gate passes again

- **WHEN** a suspended caller's key later passes the billing gate (balance restored)
- **THEN** the caller's next request is admitted normally

#### Scenario: A configured preference fires the completion callback

- **WHEN** an admitted turn for a (caller, agent) with a completion-callback preference completes
- **THEN** the facade fires the signed callback alongside settlement, and the settlement ledger and deduction are identical to a preference-free turn

#### Scenario: No preference means no callback

- **WHEN** an admitted turn for a (caller, agent) without a callback preference completes
- **THEN** no callback is fired and the settlement behaves exactly as before this change
