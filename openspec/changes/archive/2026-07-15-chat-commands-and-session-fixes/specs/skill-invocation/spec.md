## MODIFIED Requirements

### Requirement: Chat input provides slash-command autocomplete
The chat UI SHALL present a slash-command autocomplete popup (specified by the `chat-commands` capability) that includes the available `/skill:<name>` commands alongside the meta-commands (`/model`, `/new`, `/clear`, `/help`), filtered by the text typed after `/`. Skill commands in the popup SHALL be sourced from the `skills` list. The user SHALL be able to navigate the list with arrow keys and insert the selected command with Enter; Escape SHALL close the popup without inserting. Inserting a command SHALL NOT auto-send; the user may append arguments and send normally.

#### Scenario: skills appear in the unified command list
- **WHEN** the user types `/` at the start of the chat input
- **THEN** the popup SHALL list the available `/skill:` commands alongside the meta-commands

#### Scenario: filtering skills by typed text
- **WHEN** the user types `/gra` in the chat input
- **THEN** the popup SHALL list only the commands (including skills) whose names match `gra`
