## MODIFIED Requirements

### Requirement: Idempotency-Key deduplicates turns

The facade SHALL deduplicate `message/send` requests by the `Idempotency-Key` header, scoped per (caller, agent): a repeated key within the retention window returns the recorded first outcome — **only when the request body matches the recorded request fingerprint and that outcome was successful** — without running another turn, and concurrent duplicates result in exactly one turn. A recorded error outcome SHALL never be replayed: retrying the same key re-executes the turn and overwrites the record. A key whose body differs from the recorded fingerprint SHALL be refused with a structured key-reuse error identifying the conflict; the recorded outcome SHALL NOT be returned and no new turn SHALL run for the mismatched request.

#### Scenario: A replayed key returns the recorded outcome

- **WHEN** the same (caller, agent, Idempotency-Key) with the same request body is replayed after the first request completed successfully
- **THEN** the recorded first outcome is returned and no second turn runs

#### Scenario: Concurrent duplicates run one turn

- **WHEN** two requests with the same Idempotency-Key race while the first turn is still running
- **THEN** exactly one turn executes and both callers receive its outcome

#### Scenario: An error outcome is never replayed

- **WHEN** the first attempt with a key failed (e.g. the upstream agent route errored) and the caller retries the same key with the same body
- **THEN** the turn re-executes against the agent and the new outcome replaces the recorded error — the recorded error is never returned as a replay

#### Scenario: A reused key with a different body is refused

- **WHEN** a key that already recorded a successful outcome is reused with a different request body (e.g. a work ticket was reset and attempt numbering restarted)
- **THEN** the facade refuses with a structured key-reuse error, the recorded outcome is not returned, and no turn runs for the mismatched request
