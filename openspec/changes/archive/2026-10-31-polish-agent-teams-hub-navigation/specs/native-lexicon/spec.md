# native-lexicon Specification (delta)

## ADDED Requirements

### Requirement: Owner-view terminal term is 经营

The agent-teams hub owner view's user-facing term SHALL be「经营」(zh-CN; en "Operations"), replacing the jargon「经营坞」/ "Owner board" on live surfaces. The rename SHALL touch only i18n values — the key `agentTeams.views.owner`, routes, the `?view=owner` query value, and every code identifier stay unchanged. Archived specs, ledgers, and published-then documents SHALL NOT be retro-edited, following the frozen-history requirement already in this capability.

#### Scenario: tab reads 经营

- **WHEN** a user opens the agent-teams hub in zh-CN
- **THEN** the third view tab reads「经营」, and the URL keeps `?view=owner`

#### Scenario: deep links and bookmarks keep working

- **WHEN** a pre-rename bookmark `/fleets?view=owner` is opened
- **THEN** the view renders with the new label, no redirect or rewrite needed
