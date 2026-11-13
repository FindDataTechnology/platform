# chat-streaming Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.

## ADDED Requirements

### Requirement: Keyboard shortcut toggles all thinking blocks
The chat UI SHALL support a keyboard shortcut (`Ctrl+O` or `Cmd+O` on macOS) to toggle the expansion state of all thinking blocks simultaneously.

#### Scenario: Ctrl+O toggles thinking block visibility
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all thinking blocks in the chat SHALL toggle between collapsed/expanded state
- **AND** tool blocks and skill blocks SHALL NOT be affected
