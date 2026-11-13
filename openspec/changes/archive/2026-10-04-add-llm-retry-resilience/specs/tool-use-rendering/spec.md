## ADDED Requirements

### Requirement: Subagent failure cards carry the child turn's real end reason

When a delegated subagent's turn ends in error, the subagent tool failure card SHALL surface that turn's actual end reason — the error message and machine-readable error code from the child session — instead of a bare generic failure label. Rendering SHALL degrade gracefully when no end-reason detail exists (legacy sessions): the card falls back to the generic label.

#### Scenario: gateway rate-limit failure is legible
- **WHEN** a subagent turn ends with a concurrency-limit rejection from the gateway
- **THEN** the failure card SHALL show the rejection message and its error code
- **AND** the card SHALL NOT show only the generic "subagent run failed" label

#### Scenario: legacy session without end-reason detail
- **WHEN** a failed subagent run has no recorded end-reason detail
- **THEN** the failure card SHALL render the generic failure label as before
