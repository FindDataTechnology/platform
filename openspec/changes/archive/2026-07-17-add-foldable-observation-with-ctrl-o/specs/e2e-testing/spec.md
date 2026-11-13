# e2e-testing Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.

## ADDED Requirements

### Requirement: E2E suite covers thinking block keyboard shortcut
The E2E suite SHALL test that thinking blocks are displayed when the agent produces reasoning output, and that the `Ctrl+O` keyboard shortcut toggles their visibility.

#### Scenario: Thinking block appears when agent produces reasoning
- **WHEN** the agent sends a `thinking` event during a turn
- **THEN** a thinking block SHALL appear in the chat
- **AND** the block SHALL be expanded by default

#### Scenario: Ctrl+O toggles thinking block state
- **GIVEN** a thinking block is present and expanded in the chat
- **WHEN** the test presses `Ctrl+O`
- **THEN** the thinking block SHALL collapse
- **WHEN** the test presses `Ctrl+O` again
- **THEN** the thinking block SHALL expand
