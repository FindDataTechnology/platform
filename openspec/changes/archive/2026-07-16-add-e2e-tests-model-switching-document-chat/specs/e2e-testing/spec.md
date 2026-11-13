## ADDED Requirements

### Requirement: E2E suite covers model switching flow
The suite SHALL cover switching models via the UI selector and via the `/model` chat command, asserting the `model_changed` event is broadcast, the selector updates, and an error is shown for invalid model ids.

#### Scenario: model selector loads models and reflects active model
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be populated with available models
- **AND** SHALL reflect the currently active model sent in `current_model`

#### Scenario: switch model via UI selector
- **WHEN** the test selects a different model from the dropdown
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** the selector SHALL be updated to show the new active model

#### Scenario: switch model via /model command
- **WHEN** the test sends `/model <id>` through the chat input
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** a command use event SHALL be shown confirming the switch

#### Scenario: invalid model id shows error
- **WHEN** the test sends `/model nonexistent-model-id`
- **THEN** an error event SHALL be shown
- **AND** the active model SHALL remain unchanged

### Requirement: E2E suite covers document chat (RAG) flow
The suite SHALL cover the "Ask the collection" flow: adding a text document, waiting for it to be ready, querying the document collection, and verifying an answer is returned with source document names. This test SHALL be marked `@smoke` since it requires an LLM call.

#### Scenario: query document collection returns an answer
- **WHEN** the test adds a text document with known content, waits for it to be ready, and submits a query through the "Ask the collection" input
- **THEN** an answer SHALL be displayed in the answer area
- **AND** the answer SHALL reference the source document name

#### Scenario: empty collection query returns empty answer
- **WHEN** the test queries the collection with no ready documents
- **THEN** an empty or placeholder answer SHALL be shown
- **AND** no source document names SHALL be listed
