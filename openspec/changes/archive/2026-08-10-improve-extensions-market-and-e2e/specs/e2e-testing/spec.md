## ADDED Requirements

### Requirement: E2E suite covers extensions management UI flows
The suite SHALL cover the Extensions page MCP and skill management flows end-to-end through the browser, in the deterministic no-LLM `fast` Playwright project: adding an MCP server via the form and deleting it; toggling an MCP server enabled then disabled; installing an MCP server from the Store tab; opening the pre-filled form when installing from the Store; adding a custom skill and deleting it; and toggling a custom skill enabled then disabled. These tests SHALL NOT be skipped.

#### Scenario: add MCP server via form then delete
- **WHEN** the test opens the Add MCP form, fills a name and an HTTP URL, and clicks Add
- **THEN** the dialog SHALL close and a card for the new server SHALL appear in the Enabled tab
- **AND** the new card SHALL show a delete button (no "auto" badge, since it is user-added)
- **WHEN** the test clicks delete and confirms
- **THEN** the card SHALL disappear from the Enabled tab

#### Scenario: toggle MCP server enabled and disabled
- **WHEN** the test adds an MCP server and toggles it off
- **THEN** the toggle SHALL reflect the disabled state and a disabled badge SHALL appear on the card
- **WHEN** the test toggles it back on
- **THEN** the toggle SHALL reflect the enabled state and the disabled badge SHALL disappear

#### Scenario: install MCP from Store lands in Enabled
- **WHEN** the test switches to the Store tab, clicks Install on a market MCP card, fills the setup form (or confirms for a ready-to-use server), and submits
- **THEN** the Enabled tab SHALL become active and a card for the installed server SHALL appear

#### Scenario: clicking Install opens the pre-filled form
- **WHEN** the test clicks Install on a market MCP card in the Store tab
- **THEN** the Add MCP dialog SHALL open with the name field pre-filled from the catalog template
- **AND** the form SHALL be in setup mode driven by the template's configTemplate

#### Scenario: add custom skill via form then delete
- **WHEN** the test opens the Create Skill form, fills name, description, and content, and clicks Add
- **THEN** the dialog SHALL close and a card for the new skill SHALL appear in the Enabled tab
- **AND** the new card SHALL show a Custom badge and a delete button
- **WHEN** the test clicks delete and confirms
- **THEN** the skill card SHALL disappear

#### Scenario: toggle custom skill enabled and disabled
- **WHEN** the test adds a custom skill and toggles it off
- **THEN** the toggle SHALL reflect the disabled state and a disabled indicator SHALL appear on the card
- **WHEN** the test toggles it back on
- **THEN** the toggle SHALL reflect the enabled state and the disabled indicator SHALL disappear
