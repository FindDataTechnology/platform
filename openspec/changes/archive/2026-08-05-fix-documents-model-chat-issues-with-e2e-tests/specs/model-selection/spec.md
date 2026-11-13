## ADDED Requirements

### Requirement: Model selector input click does not throw errors
Clicking on the model selector input SHALL open the dropdown and SHALL NOT throw JavaScript errors. The click handler SHALL properly handle null or undefined references and ensure the dropdown state is managed correctly.

#### Scenario: clicking model selector opens dropdown
- **WHEN** user clicks on the model selector input
- **THEN** the model dropdown SHALL open
- **AND** no JavaScript error SHALL be thrown

#### Scenario: model selector shows current model
- **WHEN** the page loads and the current model is received
- **THEN** the model selector SHALL display the current model id
- **AND** the input SHALL not be empty

## MODIFIED Requirements

### Requirement: Model selector is enabled as soon as models are known
The chat UI SHALL enable the model selector as soon as the available models are received, not only after the first agent turn completes. The selector SHALL be disabled while the agent is streaming and re-enabled when the turn ends (whether it succeeded or failed). The selector SHALL reflect the currently active model. The UI SHALL provide a command list popup showing available models as clickable items that trigger model selection. The click handler SHALL safely check for null DOM references before accessing properties.

#### Scenario: selector enabled on connect
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be enabled
- **AND** SHALL reflect the currently active model

#### Scenario: selector re-enabled after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the model selector SHALL be re-enabled

#### Scenario: model selection from command list
- **WHEN** the user opens the command list and clicks on a model name
- **THEN** the UI SHALL send a `set_model` message with the clicked model id
- **AND** SHALL reflect the new active model in the selector
