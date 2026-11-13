## MODIFIED Requirements

### Requirement: Keyboard shortcut toggles all thinking blocks
The chat UI SHALL support a keyboard shortcut (`Ctrl+O` or `Cmd+O` on macOS) to toggle the expansion state of all activity groups simultaneously.

#### Scenario: Ctrl+O toggles thinking block visibility
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all activity groups in the chat SHALL toggle between collapsed/expanded state
- **AND** the inner per-block collapse states SHALL NOT be affected
