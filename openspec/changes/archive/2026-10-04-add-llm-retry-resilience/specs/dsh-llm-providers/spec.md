## ADDED Requirements

### Requirement: Generated provider profiles carry a transient-error retry policy

Every LLM provider profile the platform generates (the env-driven default route and every user-added route from the Models page) SHALL carry a retry policy that retries transient request failures with bounded exponential backoff. The retryable set SHALL include rate-limit rejections, server errors, timeouts, transport failures, empty responses, and the adapter's unrecognized-error fallback bucket (a gateway whose rejection wording defeats message-pattern classification must still be retried). The policy SHALL be bounded (finite attempts, capped delay, jittered) — never unbounded retrying. Policy changes SHALL take effect via the settings hot-reload path without a runtime restart.

#### Scenario: concurrency-limited request is retried, not fatal
- **WHEN** the gateway rejects a model request with a concurrency-limit rejection whose text contains neither a status code nor the words "rate limit"
- **THEN** the request SHALL be retried with backoff up to the configured finite budget
- **AND** the turn SHALL complete normally if a retry succeeds

#### Scenario: policy applies to user-added routes
- **WHEN** a user adds or edits a provider on the Models page
- **THEN** the generated profile for that route SHALL carry the same retry policy semantics as the default route

#### Scenario: policy reaches the runtime without restart
- **WHEN** the generated settings section changes a provider's retry policy
- **THEN** the running runtime SHALL pick up the new policy via settings hot-reload
- **AND** the next failed request SHALL be governed by the new policy
