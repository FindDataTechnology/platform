# chat-input-focus Specification

## Purpose
TBD - created by archiving change chat-ux-model-selector-fixes. Update Purpose after archive.

## Requirements

### Requirement: Chat input auto-focuses on new session
The chat UI SHALL focus the chat input textarea when a new session is created, either by clicking the "New chat" button or executing the `/new` command.

#### Scenario: Auto-focus on new chat button click
- **WHEN** the user clicks the "New chat" button
- **THEN** the chat input textarea SHALL receive focus

#### Scenario: Auto-focus on /new command
- **WHEN** the user executes the `/new` command
- **THEN** the chat input textarea SHALL receive focus
