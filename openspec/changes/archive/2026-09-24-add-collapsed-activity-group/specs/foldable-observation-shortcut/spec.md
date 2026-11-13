## MODIFIED Requirements

### Requirement: Ctrl/Cmd+O toggles all thinking blocks
The chat UI SHALL toggle the expansion state of all activity groups when the user presses `Ctrl+O` (or `Cmd+O` on macOS). The shortcut SHALL affect activity groups; the inner per-block collapse states SHALL NOT be changed by the shortcut.

#### Scenario: Ctrl+O collapses all expanded thinking blocks
- **GIVEN** the chat contains one or more activity groups in the expanded (open) state
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all activity groups SHALL collapse (hide their content)

#### Scenario: Ctrl+O expands all collapsed thinking blocks
- **GIVEN** the chat contains one or more activity groups in the collapsed state
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all activity groups SHALL expand (show their content)

#### Scenario: Shortcut toggles mixed-state thinking blocks
- **GIVEN** the chat contains some activity groups expanded and some collapsed
- **WHEN** the user presses the shortcut
- **THEN** all groups SHALL toggle to the opposite of their current state

### Requirement: Thinking blocks default to expanded
Thinking blocks SHALL carry their own expanded (open) state by default when created, so that expanding the enclosing activity group reveals thinking content without a further toggle. User-visible visibility of thinking content is governed by the enclosing activity group, which defaults to collapsed (see the chat-activity-collapse capability).

#### Scenario: New thinking block is expanded
- **WHEN** the UI receives a `thinking` event and creates a new thinking block
- **THEN** the block SHALL carry the expanded (open) state, visible whenever its enclosing activity group is expanded

#### Scenario: Thinking does not stream visibly open
- **WHEN** thinking deltas arrive during a streaming turn
- **THEN** the enclosing activity group SHALL stay collapsed and the thinking text SHALL NOT be visible until the user expands the group
