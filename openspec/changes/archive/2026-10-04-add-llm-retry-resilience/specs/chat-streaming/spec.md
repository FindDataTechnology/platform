## ADDED Requirements

### Requirement: Retry progress is visible in the session stream

Durable retry events emitted by the runtime's request-retry machinery (a scheduled retry with its delay and attempt budget, and a started retry) SHALL be forwarded to connected clients as session-stream events and rendered as visible progress on the affected turn (e.g. "网关限流，重试中 (2/5)"), not silently swallowed. Retry events SHALL NOT appear as assistant text and SHALL NOT alter the turn's durable message history.

#### Scenario: rate-limited request shows retry progress
- **WHEN** a model request fails with a transient rejection and the runtime schedules a retry
- **THEN** clients SHALL see a retry-scheduled indication for that turn including attempt number and budget
- **AND** when the retry starts, the indication SHALL update

#### Scenario: retry succeeds
- **WHEN** a scheduled retry completes the request successfully
- **THEN** the turn SHALL proceed normally and the retry indication SHALL resolve without a fatal turn error

#### Scenario: retry budget exhausted
- **WHEN** all retry attempts for a request are exhausted
- **THEN** the turn SHALL end with the real error surfaced per the failure-rendering behavior
