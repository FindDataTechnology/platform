## MODIFIED Requirements

### Requirement: Active session cannot be deleted from the menu
If the right-clicked session is the current/active session, OR its `turnStatus` is `running` or `queued`, the Delete entry SHALL be disabled (greyed out) with a tooltip explaining why ("Switch to another session first" for the active session; "This chat is still running" / "This chat has a queued message" otherwise). This mirrors the server-side 409 — the UI prevents the obviously-wrong action.

#### Scenario: delete disabled on active session
- **WHEN** the user opens the context menu on the currently active session
- **THEN** the Delete entry SHALL be disabled and show the tooltip
- **AND** clicking it SHALL NOT trigger any request

#### Scenario: delete disabled on a background-running session
- **WHEN** the user views session B and opens the context menu on session A whose `turnStatus` is `running`
- **THEN** the Delete entry SHALL be disabled with the "still running" tooltip
- **AND** clicking it SHALL NOT trigger any request

#### Scenario: delete disabled on a queued session
- **WHEN** the user opens the context menu on a session whose `turnStatus` is `queued`
- **THEN** the Delete entry SHALL be disabled with the "queued message" tooltip

## ADDED Requirements

### Requirement: Sidebar shows each session's turn status
Each session row SHALL render an indicator derived from the `sessions` payload's `turnStatus`: a running indicator (the existing loader style) when `running`, a queued indicator (clock glyph) when `queued`, nothing when null. The indicator SHALL update on every `sessions` broadcast with no additional subscription and SHALL be visible regardless of which session is currently viewed. Both indicators SHALL carry accessible labels resolved through the i18n bundle.

#### Scenario: background session shows running
- **WHEN** session A's turn is in flight and the user views session B
- **THEN** A's sidebar row SHALL show the running indicator and B's SHALL show none

#### Scenario: queued session shows waiting
- **WHEN** session B's prompt is queued behind A
- **THEN** B's row SHALL show the queued indicator and A's the running indicator
- **AND** when A closes and B dispatches, the next `sessions` broadcast SHALL flip B to running and clear A
