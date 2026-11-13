# model-selection delta

## ADDED Requirements

### Requirement: Sidebar model indicator is read-only
The sidebar's model display SHALL be a read-only chip showing the current default model id (sourced from the WS `current_model` event). Clicking the chip SHALL navigate the user to `/models` for the actual configuration. The legacy in-sidebar `<select>` for switching the model is replaced by the Set-as-default action on the Models page (see `llm-model-management`). The sidebar's Agent `<select>` is unchanged (it manages a different axis — `agent-local` vs `agent-remote`).

#### Scenario: clicking model chip navigates
- **WHEN** the user clicks the model chip in the sidebar
- **THEN** the router SHALL navigate to `/models`
- **AND** no model-switch WS message SHALL be sent

#### Scenario: model chip reflects current default
- **WHEN** the WS `current_model` event arrives
- **THEN** the sidebar model chip SHALL display the new model id
- **WHEN** the user changes the default on `/models`
- **THEN** a `model_changed` event SHALL be broadcast
- **AND** the chip SHALL update accordingly
