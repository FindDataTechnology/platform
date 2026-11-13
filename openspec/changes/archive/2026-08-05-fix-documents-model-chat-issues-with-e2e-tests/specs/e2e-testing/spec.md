## ADDED Requirements

### Requirement: E2E suite covers documents collection save flow
The suite SHALL cover creating a collection, adding documents to it, saving the collection, and asserting the collection persists with the correct document count.

#### Scenario: create and save a document collection
- **WHEN** the test creates a collection, adds documents, and clicks Save
- **THEN** the collection SHALL appear in the collections list
- **AND** SHALL have the correct document count

### Requirement: E2E suite covers model selector click and switch flow
The suite SHALL cover clicking the model selector, asserting the dropdown opens without errors, selecting a different model, and asserting the model changes.

#### Scenario: model selector click works without error
- **WHEN** the test clicks on the model selector input
- **THEN** no JavaScript error SHALL be thrown
- **AND** the model dropdown SHALL be visible

#### Scenario: model switch via selector
- **WHEN** the test selects a different model from the dropdown
- **THEN** the `model_changed` event SHALL be received
- **AND** the selector SHALL display the new model id

### Requirement: E2E suite covers basic chat prompt submission flow
The suite SHALL cover typing a prompt, clicking send, and asserting the message is sent without JavaScript errors.

#### Scenario: chat prompt submission works without error
- **WHEN** the test types a prompt and clicks Send
- **THEN** the user message SHALL appear in the chat
- **AND** no JavaScript error SHALL be thrown
- **AND** the input SHALL be disabled during streaming
