## ADDED Requirements

### Requirement: Sidebar navigation includes a Bots entry
The sidebar SHALL include a "Bots" navigation entry linking to the `/bots` route, localized in all supported languages.

#### Scenario: navigation to bots management
- **WHEN** the user clicks the Bots entry in the sidebar
- **THEN** the app SHALL navigate to `/bots` without a page reload, keeping the WebSocket connected
