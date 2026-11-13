# wanxing-facade Specification Delta

## MODIFIED Requirements

### Requirement: The facade speaks A2A natively at per-agent routes

The facade SHALL expose each deployed agent at a stable external route derived from the agent's deployment identity, accepting JSON-RPC `message/send` (synchronous final response) and `message/stream` (SSE passthrough) at the agent's base path, serving its AgentCard at the well-known card path without authentication, and listing public agents with card summaries in a public catalog. Route resolution and the catalog SHALL be served from the cached deployment-bookkeeping snapshot rather than a per-request full fetch. The catalog SHALL support `page`/`page_size` pagination; a request without pagination parameters SHALL return the full list (backward compatible). Unsupported A2A methods SHALL return the protocol's method-not-found error. The facade SHALL forward admitted requests to the agent's runtime route over the platform's internal credentials without altering A2A protocol semantics. Unless the caller supplies a `context_id`, the facade SHALL derive a fresh external context per idempotency key.

#### Scenario: Send returns the agent's completed reply

- **WHEN** an admitted caller invokes `message/send` with a text part
- **THEN** the response returns the agent's reply as text parts once the turn completes

#### Scenario: Stream passes deltas through

- **WHEN** an admitted caller invokes `message/stream`
- **THEN** SSE events pass through incrementally and the stream terminates when the turn completes

#### Scenario: Card and catalog are public

- **WHEN** an unauthenticated party fetches an agent's well-known card path or the agent catalog
- **THEN** public agents' cards and summaries are returned without any credential

#### Scenario: Route resolution reads the snapshot

- **WHEN** an external turn arrives for an agent slug
- **THEN** the slug resolves against the cached snapshot in constant time, without a per-request full bookkeeping fetch

#### Scenario: Catalog paginates on request

- **WHEN** the catalog is requested with `page` and `page_size`
- **THEN** the response contains that page of public agents plus a `total` count, and a request without pagination parameters returns the full list

#### Scenario: A caller-supplied context continues

- **WHEN** an admitted caller reuses a `context_id` it previously used
- **THEN** the conversation continues on that context's runtime session, subject to idle reaping

#### Scenario: Unsupported method

- **WHEN** an admitted caller invokes an A2A method the facade does not implement
- **THEN** a JSON-RPC method-not-found error is returned and no turn runs

## ADDED Requirements

### Requirement: Deployment bookkeeping snapshot serves resolution and change detection

The facade SHALL maintain an in-process cached snapshot of the deployment bookkeeping (the packs internal API), refreshed on a TTL with single-flight merging, indexed by slug for O(1) resolution. When the source is unreachable the last snapshot SHALL be served stale (matching the registry-entry cache's semantics); staleness beyond a hard window (5 minutes) SHALL degrade to the explicit source-unavailable error rather than serving an indefinitely stale catalog. Snapshot refreshes SHALL compute the deployment diff (added/removed/changed) via an exported pure function, so the fleet observer's bookkeeping-change detector (fd-wanxing program slice ③) reuses the same logic by minimal copy until the facade extraction converges it.

#### Scenario: Source hiccup serves stale

- **WHEN** a refresh attempt fails within the hard staleness window
- **THEN** resolution and the catalog continue serving the last snapshot without error

#### Scenario: Hard staleness degrades explicitly

- **WHEN** the snapshot has been unreachable for longer than the hard window
- **THEN** catalog and card routes respond with the explicit source-unavailable error instead of a stale list

#### Scenario: Diff detects bookkeeping changes

- **WHEN** a refresh observes deployments added, removed, or changed versus the previous snapshot
- **THEN** the exported diff function reports exactly those three buckets, and an unchanged refresh reports all three empty
