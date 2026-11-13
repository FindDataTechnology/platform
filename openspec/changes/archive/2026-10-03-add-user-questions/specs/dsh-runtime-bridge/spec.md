## ADDED Requirements

### Requirement: The runtime registers a platform user-questions provider

The composed dsh runtime SHALL register a user-questions provider so that `ask_user_question` tool calls in platform sessions are delivered to the platform host instead of failing with a missing-provider error. A delivered ask SHALL carry the asking session's identity and the full question batch, and the tool call SHALL remain pending until the platform returns an answer or a cancellation.

#### Scenario: ask reaches the platform

- **WHEN** the agent calls `ask_user_question` in a platform session
- **THEN** the platform host receives the question batch and the session identity, and no missing-provider error is produced

#### Scenario: delegated callers never surface a card

- **WHEN** an agent owned by another live agent attempts `ask_user_question`
- **THEN** the runtime rejects the call with the delegated-caller error and no question is delivered to any surface

### Requirement: Pending asks resolve over the host-to-runtime request channel

The platform SHALL deliver answers and cancellations for pending asks to the runtime over the existing host-to-runtime request channel. An answer SHALL resolve the pending tool call with the structured answer batch; a cancellation SHALL resolve it with a cancelled error the model can observe and recover from.

#### Scenario: answer resolves the tool call

- **WHEN** the platform delivers an answer for a pending ask
- **THEN** the tool call completes with that answer and the turn continues with the answer as the tool result

#### Scenario: cancellation surfaces as a recoverable error

- **WHEN** the platform delivers a cancellation for a pending ask
- **THEN** the tool call completes with a cancelled error and the model continues the turn

### Requirement: Runtime lifecycle releases pending asks safely

WHEN the runtime exits, restarts, or its turn aborts while an ask is pending, the ask SHALL be released — never left permanently wedged — and connected surfaces SHALL observe the failure through the tool call's error outcome.

#### Scenario: restart mid-ask

- **WHEN** the runtime restarts while a question card is pending on a surface
- **THEN** the pending ask is released and the card resolves to an error state instead of waiting forever
