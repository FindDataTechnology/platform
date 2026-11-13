# foldable-observation-shortcut Specification

## Purpose

Provides a keyboard shortcut to quickly toggle the expansion state of all thinking/observation blocks in the chat UI, improving accessibility and workflow efficiency for users who frequently interact with extended reasoning outputs.

## ADDED Requirements

### Requirement: Ctrl/Cmd+O toggles all thinking blocks
The chat UI SHALL toggle the expansion state of all thinking/observation blocks when the user presses `Ctrl+O` (or `Cmd+O` on macOS). The shortcut SHALL affect only thinking blocks, not tool blocks or skill blocks.

#### Scenario: Ctrl+O collapses all expanded thinking blocks
- **GIVEN** the chat contains one or more thinking blocks in the expanded (open) state
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all thinking blocks SHALL collapse (hide their content)

#### Scenario: Ctrl+O expands all collapsed thinking blocks
- **GIVEN** the chat contains one or more thinking blocks in the collapsed state
- **WHEN** the user presses `Ctrl+O` (Windows/Linux) or `Cmd+O` (macOS)
- **THEN** all thinking blocks SHALL expand (show their content)

#### Scenario: Shortcut toggles mixed-state thinking blocks
- **GIVEN** the chat contains some thinking blocks expanded and some collapsed
- **WHEN** the user presses the shortcut
- **THEN** all thinking blocks SHALL toggle to the opposite of their current state

### Requirement: Thinking blocks default to expanded
Thinking blocks SHALL be rendered in the expanded (open) state by default when created, matching the existing behavior.

#### Scenario: New thinking block is expanded
- **WHEN** the UI receives a `thinking` event and creates a new thinking block
- **THEN** the block SHALL have the `open` CSS class applied initially
