# open-connector-ui delta

## ADDED Requirements

### Requirement: OpenConnector page moves into the Settings menu
The OpenConnector management page (rendered as a same-origin iframe around `/oc-web`) SHALL remain mounted at the `/openconnector` route, but SHALL NO LONGER appear as a top-level sidebar tab. It SHALL be reachable from the Settings menu in the sidebar footer (see `app-navigation`). The page content, the iframe proxy behavior, the loading/blocked-frame fallback, and the not-configured placeholder are unchanged.

#### Scenario: OpenConnector no longer in top-level nav
- **WHEN** the user views the sidebar
- **THEN** no top-level "OpenConnector" entry SHALL be present
- **WHEN** the user opens the Settings menu (gear icon)
- **THEN** an "OpenConnector" item SHALL appear
- **WHEN** the user clicks that item
- **THEN** the router SHALL navigate to `/openconnector` and the iframe page SHALL render

#### Scenario: direct navigation still works
- **WHEN** the user navigates directly to `/openconnector` (e.g. via a bookmark)
- **THEN** the OpenConnector page SHALL render exactly as before this change
