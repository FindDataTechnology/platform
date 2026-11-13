## MODIFIED Requirements

### Requirement: User can edit an MCP server configuration
The UI SHALL provide an "Edit" button for each MCP server that opens the configuration form pre-filled with the current values. Saving SHALL preserve config fields the form does not model (notably `envRefs` on stdio servers) rather than dropping them, and SHALL NOT silently strip a bundled server's deployment wiring.

#### Scenario: User edits an MCP server
- **WHEN** the user clicks "Edit" on an MCP server entry
- **THEN** the UI SHALL open the configuration form with current values pre-filled
- **AND** when the user saves changes, the server SHALL disconnect from the old configuration
- **AND** reconnect with the new configuration
- **AND** update the list entry

#### Scenario: Editing preserves unmodeled config fields
- **WHEN** the user edits a server whose config carries fields the form does not render (e.g. `envRefs`) and saves without touching them
- **THEN** the saved config SHALL retain those fields unchanged

#### Scenario: Bundled server wiring points to its settings section
- **WHEN** a bundled server's deployment wiring is managed by a dedicated settings section (the websearch relay pair)
- **THEN** its edit surface SHALL indicate where the wiring is configured instead of inviting an edit that would strip it
