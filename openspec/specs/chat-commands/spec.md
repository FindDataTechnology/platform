# chat-commands Specification

## Purpose
TBD - created by archiving change chat-commands-and-session-fixes. Update Purpose after archive.
## Requirements
### Requirement: Server parses and dispatches general chat slash-commands
The server SHALL accept chat prompts whose first token is a slash-command and dispatch them according to a command table that includes `/model`, `/new`, `/clear`, `/help`, and `/skill:<name>`. Server-handled commands (`/model`, `/new`, `/skill:`) SHALL be dispatched to their behavior; client-handled commands (`/clear`, `/help`) SHALL be intercepted by the UI before the prompt is sent and SHALL NOT be forwarded to the agent. The raw text of a recognised server-handled command SHALL NOT be echoed as a normal user message. The UI SHALL clear the chat input field after executing any slash command.

#### Scenario: server-handled command is dispatched
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }`
- **THEN** the server SHALL dispatch the `/model` command
- **AND** SHALL NOT forward the raw `/model …` text to the agent as a user message

#### Scenario: client-handled command is not forwarded
- **WHEN** the user types `/clear` and sends
- **THEN** the UI SHALL handle the command locally
- **AND** SHALL NOT send a `prompt` message to the server

#### Scenario: unknown command falls through to the agent
- **WHEN** a client sends a prompt beginning with `/` that is not a recognised command
- **THEN** the server SHALL forward the text to the agent as a normal prompt

#### Scenario: input is cleared after slash command
- **WHEN** the user executes any slash command (local or server-handled)
- **THEN** the chat input field SHALL be cleared

### Requirement: Command invocations render as collapsible blocks
The chat UI SHALL render each server-handled command invocation as a collapsible `command_use` block showing the command name in its header and the arguments (and any informational message) in its body, in place of echoing the raw command text as a user message.

#### Scenario: command invocation displayed
- **WHEN** the server sends a `command_use` event for command `model` with args `deepseek-v4-pro`
- **THEN** the UI SHALL render a collapsible block with the command name `model` in its header
- **AND** the body SHALL show the arguments
- **AND** the raw `/model …` text SHALL NOT be rendered as a normal user message

### Requirement: Chat input provides unified slash-command autocomplete
The composer SHALL show a popover when the user types `/` at the start of an input or after a space. The popover SHALL list every available chat command and skill (from the WS `skills` event and the built-in commands like `/model`, `/clear`, `/skill:<name>`) grouped into "Commands" and "Skills" sections with a visible divider. Each entry SHALL show the canonical form (e.g. `/skill:foo`) and a short description. The popover SHALL filter entries as the user types; arrow keys navigate; Enter inserts the chosen entry into the composer; Escape dismisses the popover without modifying the composer's text.

#### Scenario: typing slash opens picker
- **WHEN** the user types `/` as the first character of the composer
- **THEN** the popover SHALL appear with the full list of skills and commands grouped into "Commands" and "Skills" sections
- **AND** the first entry SHALL be highlighted

#### Scenario: filter by typing
- **WHEN** the popover is open and the user types additional characters
- **THEN** the list SHALL filter to entries whose canonical form contains the typed substring (case-insensitive)
- **AND** the first matching entry SHALL be highlighted

#### Scenario: select with Enter
- **WHEN** the popover is open and the user presses Enter on a highlighted entry
- **THEN** the composer's text SHALL be replaced with the entry's canonical form (followed by a trailing space)
- **AND** the popover SHALL close
- **AND** the composer SHALL remain focused so the user can continue typing arguments

#### Scenario: dismiss with Escape
- **WHEN** the popover is open and the user presses Escape
- **THEN** the popover SHALL close
- **AND** the composer's text SHALL be unchanged

### Requirement: Slash picker groups built-in commands and skills
The slash-command popover SHALL include the built-in chat commands (`/model`, `/new`, `/clear`, `/help`) in a "Commands" section and the loaded skills (from the WS `skills` event) in a "Skills" section, separated by a visible divider. The source of truth for built-ins is the chat-composer's command constant; the source for skills is the WS `skills` event. The first item across both sections SHALL be highlighted by default; the highlight SHALL wrap within each section but SHALL NOT cross sections.

#### Scenario: two groups in the picker
- **WHEN** the popover is open with the default list
- **THEN** the picker SHALL show a "Commands" section containing `/model`, `/new`, `/clear`, and `/help`
- **AND** a "Skills" section containing the discovered skills
- **AND** the two sections SHALL have visible dividers between them

