## MODIFIED Requirements

### Requirement: Chat input provides unified slash-command autocomplete
The chat UI SHALL present a slash-command autocomplete popup listing all available commands - the meta-commands (`/model`, `/new`, `/clear`, `/help`) and the `/skill:<name>` commands sourced from the `skills` list - filtered by the text typed after `/`. The user SHALL be able to navigate the list with arrow keys and insert the selected command with Enter; Escape SHALL close the popup without inserting. Inserting a command SHALL NOT auto-send; the user may append arguments and send normally. The UI SHALL also provide a visible button to open a command list popup that shows all available commands and models.

#### Scenario: typing slash lists all commands
- **WHEN** the user types `/` at the start of the chat input
- **THEN** the UI SHALL show a popup listing the meta-commands and all available `/skill:` commands

#### Scenario: filtering by typed text
- **WHEN** the user types `/mod` in the chat input
- **THEN** the popup SHALL list only the commands whose names match `mod`

#### Scenario: enter inserts the command without sending
- **WHEN** the user selects a command in the popup and presses Enter
- **THEN** the command text SHALL be inserted into the chat input with a trailing space
- **AND** the popup SHALL close
- **AND** the message SHALL NOT be sent

#### Scenario: escape closes the popup without inserting
- **WHEN** the popup is open and the user presses Escape
- **THEN** the popup SHALL close
- **AND** no command SHALL be inserted into the input

#### Scenario: command list button opens popup
- **WHEN** the user clicks the command list button
- **THEN** the UI SHALL show a popup listing all available slash commands and models
- **AND** clicking a command SHALL insert it into the input
- **AND** clicking a model SHALL select it as the active model
