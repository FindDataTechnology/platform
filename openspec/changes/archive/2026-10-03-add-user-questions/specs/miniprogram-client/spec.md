## ADDED Requirements

### Requirement: The mini-program renders the question card with web parity

The mini-program chat SHALL render a pending ask as an interactive question card aligned with the web interaction: selectable options, multi-select where declared, an in-card free-text field for custom answers, and a cancel affordance. While a card is pending in the streaming turn, the mini-program composer SHALL be disabled; when another surface resolves the ask first, the card SHALL converge to the resolved summary.

#### Scenario: answering from the mini-program

- **WHEN** the user selects options or types custom text on a pending card and submits
- **THEN** the answer is sent over the shared chat transport and the card resolves

#### Scenario: cancelling from the mini-program

- **WHEN** the user activates the card's cancel affordance
- **THEN** a cancellation is sent and the card resolves without an answer

#### Scenario: composer gated while pending

- **WHEN** a question card is pending in the streaming turn
- **THEN** the mini-program composer is disabled until the ask resolves

#### Scenario: resolution from another surface

- **WHEN** the pending ask is resolved from another surface
- **THEN** the mini-program card converges to the resolved summary without error
