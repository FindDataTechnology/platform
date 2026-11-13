# wanxing-facade 变更 Delta

## MODIFIED Requirements

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
