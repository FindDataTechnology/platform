# app-navigation delta

## ADDED Requirements

### Requirement: Models tab content is now backed by the Models page
The Models tab (`/models`) introduced by `ui-nav-restructure` is now backed by the first-class Models page (see `llm-model-management`). The placeholder route from `ui-nav-restructure` is replaced by the new page. The tab MUST continue to be present in the canonical tab set (Chat, Knowledge, Agents, MCP Servers, Skills, Models). The Models page is the canonical place to add/edit/remove LLM providers and to set the default model; the sidebar's model chip is read-only and navigates here when clicked (see `model-selection`).

#### Scenario: clicking Models tab shows the Models page
- **WHEN** the user clicks the Models sidebar tab
- **THEN** the URL SHALL be `/models`
- **AND** the page SHALL render the provider cards, Add provider button, and default-model affordance (per `llm-model-management`)

#### Scenario: Models tab is not a placeholder
- **WHEN** the page renders
- **THEN** no "coming soon" placeholder SHALL be shown
- **AND** at least one provider SHALL be visible (the configured default)
