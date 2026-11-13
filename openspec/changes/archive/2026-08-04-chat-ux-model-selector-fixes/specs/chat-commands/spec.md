## MODIFIED Requirements

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

### Requirement: User can switch the active model at runtime
The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the agent session's active model via the SDK's runtime model-switch API, validating that the requested model is available and has configured auth. A `/model` command with no argument SHALL report the currently active model AND list all available selectable models. The switched model SHALL apply to the next agent turn. (Model switching is rejected while the agent is streaming, per the dedicated streaming-guard requirement.)

#### Scenario: user selects a valid model via the selector
- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id

#### Scenario: user switches model via the /model command
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }` for a model in the available list
- **THEN** the server SHALL switch the session's active model and broadcast `model_changed` with the new id
- **AND** SHALL broadcast a `command_use` event for the `model` command

#### Scenario: /model with no argument reports current model and lists available models
- **WHEN** a client sends `{ "type": "prompt", "text": "/model" }`
- **THEN** the server SHALL broadcast a `command_use` event reporting the currently active model
- **AND** SHALL include a list of all available selectable models in the message
- **AND** SHALL NOT switch the model

#### Scenario: user selects an unknown model
- **WHEN** a client sends `set_model` or `/model nonexistent` for a model not in the available list
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged
