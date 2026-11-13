## ADDED Requirements

### Requirement: Chat input provides slash-command autocomplete
The chat UI SHALL present a slash-command autocomplete popup in the chat input. When the user types a `/` token, the UI SHALL show the available `/skill:` commands (sourced from the `skills` list) filtered by the text typed after `/`. The user SHALL be able to navigate the list with arrow keys and insert the selected command into the input with Enter; Escape SHALL close the popup without inserting. Inserting a command SHALL NOT auto-send; the user may append arguments and send normally.

#### Scenario: typing slash opens the command list
- **WHEN** the user types `/` at the start of the chat input
- **THEN** the UI SHALL show a popup listing all available `/skill:` commands

#### Scenario: filtering by typed text
- **WHEN** the user types `/gra` in the chat input
- **THEN** the popup SHALL list only the skills whose names match `gra`

#### Scenario: enter inserts the command without sending
- **WHEN** the user selects a skill in the popup and presses Enter
- **THEN** `/skill:<name> ` SHALL be inserted into the chat input
- **AND** the popup SHALL close
- **AND** the message SHALL NOT be sent

#### Scenario: escape closes the popup without inserting
- **WHEN** the popup is open and the user presses Escape
- **THEN** the popup SHALL close
- **AND** no command SHALL be inserted into the input
