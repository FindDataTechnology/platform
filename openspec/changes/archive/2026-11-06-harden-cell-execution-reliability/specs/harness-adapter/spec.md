## ADDED Requirements

### Requirement: Every outgoing HTTP call from platform processes carries a timeout

Gateway and server processes SHALL issue no outbound HTTP call without a bounded timeout: a shared fetch wrapper with a default timeout (overridable per call site) SHALL cover the login path (WeChat code2Session exchange) and the MCP bridge family, and all remaining bare `fetch` call sites. Timeout errors SHALL surface as structured failures distinguishable as retryable, not as hangs.

#### Scenario: Login exchange cannot hang the browser session

- **WHEN** the WeChat code2Session endpoint is unreachable and a user logs in
- **THEN** the exchange fails with a timeout error within the configured bound and the login surface shows a retryable failure

#### Scenario: Loopback self-call timeout self-heals

- **WHEN** an MCP bridge call to a loopback service stalls beyond the timeout
- **THEN** the call fails with a structured timeout error and the calling lane records a retryable failure instead of hanging

### Requirement: Core execution modules carry contract tests

The four untested core execution modules SHALL each carry a minimum contract test: `server/cron-runner.js` (state transitions and catch-up decisions via extracted pure functions), `gateway/index.js` (assembly smoke asserting the OpenAPI paths shape), `gateway/cell-report.js` (report payload shape), and `agent-runner/harness/acp.js` (adapter contract parity with the dsh adapter's test seam). These tests SHALL run in the standard unit lane.

#### Scenario: Cron-runner decisions are testable pure functions

- **WHEN** the catch-up/retry decision logic is extracted from cron-runner into pure functions
- **THEN** a unit test covers fire/skip/backoff decisions across the tolerance window boundary cases

#### Scenario: Gateway assembly smoke

- **WHEN** the gateway app assembles in test mode
- **THEN** an assertion on the OpenAPI paths shape passes (assembly regression guard)
