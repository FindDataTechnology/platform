## MODIFIED Requirements

### Requirement: LiteLLM management entry in the sidebar
The sidebar SHALL render a LiteLLM nav entry that, when activated, switches the main content area to an in-app LiteLLM view embedding the proxy's management UI through the server's `/litellm-web` reverse proxy (governed by the `litellm-web` capability), mirroring how OpenConnector embeds its runtime UI. The entry SHALL be shown only when LiteLLM is configured; when LiteLLM is not configured the entry SHALL be absent. The entry SHALL NOT open the management UI in a new browser tab as its primary action.

#### Scenario: entry shown when LiteLLM is configured
- **WHEN** the page loads and LiteLLM is configured
- **THEN** the sidebar SHALL render a LiteLLM nav entry

#### Scenario: entry hidden when LiteLLM is not configured
- **WHEN** the page loads and LiteLLM is not configured
- **THEN** the sidebar SHALL NOT render a LiteLLM nav entry

#### Scenario: activating the entry opens the in-app view
- **WHEN** the user clicks the LiteLLM nav entry
- **THEN** the main content area SHALL switch to the LiteLLM view
- **AND** the view SHALL embed the management UI via the `/litellm-web` proxy

## ADDED Requirements

### Requirement: Drag-drop overlay is subtle and label-free
The drag-drop overlay SHALL NOT display a prominent text label such as "Drop files to add to documents". Drop feedback SHALL be conveyed by a transient toast and the chat-view document banner; the overlay, if shown during a drag, SHALL be a subtle visual affordance without prominent text.

#### Scenario: dragging a file shows no prominent label
- **WHEN** the user drags a file over the page
- **THEN** the overlay SHALL NOT display a prominent text label
- **AND** drop feedback SHALL be conveyed by the toast and/or the chat-view document banner
