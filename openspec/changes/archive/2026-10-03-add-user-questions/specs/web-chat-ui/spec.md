## ADDED Requirements

### Requirement: A pending ask renders as an interactive question card

While an `ask_user_question` tool call is pending, the chat UI SHALL render it as a question card: one section per question with its options as selectable choices, multi-select where the question declares it, an in-card free-text field whose content is submitted as the custom answer, and a cancel affordance. Presentation intents (e.g. plan review) SHALL render as the generic option list. While the card is pending, the composer SHALL be disabled.

#### Scenario: option selection submits an answer

- **WHEN** the user selects an option and submits the pending card
- **THEN** the selected option label is sent as the answer and the card stops accepting input

#### Scenario: free text submits as a custom answer

- **WHEN** the user types free text into the card's input and submits
- **THEN** the text is sent as the custom answer for that question

#### Scenario: cancel dismisses the ask

- **WHEN** the user activates the card's cancel affordance
- **THEN** a cancellation is sent and the card resolves without an answer

#### Scenario: plan-review question renders generically

- **WHEN** a pending question declares a plan-review intent
- **THEN** it renders as the generic option list and its answers encode identically

#### Scenario: composer is gated while pending

- **WHEN** a question card is pending in the streaming turn
- **THEN** the composer is disabled until the ask resolves

### Requirement: Resolved cards collapse to a summary and replay from history

After an ask resolves, the card SHALL become a non-interactive summary showing the outcome — the given answers, a cancellation, or an error — and history replay SHALL render the same summary shape without live inputs.

#### Scenario: answered card shows the answers

- **WHEN** a pending ask is answered
- **THEN** the card renders a static summary of the chosen answers

#### Scenario: history replay shows a static card

- **WHEN** a past turn containing an `ask_user_question` call is loaded from history
- **THEN** the ask renders as a static summary, never as an interactive card

### Requirement: Concurrent surfaces converge on the first answer

WHEN another surface resolves the pending ask first, a client's card SHALL converge to the final resolved state without error.

#### Scenario: another surface answered first

- **WHEN** the ask is resolved from a different surface while a client's card is still pending
- **THEN** the card updates to the answered summary with no error shown
