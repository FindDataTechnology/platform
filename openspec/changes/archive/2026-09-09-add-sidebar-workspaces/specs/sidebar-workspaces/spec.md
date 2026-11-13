## Purpose

Gives the sidebar a Workspaces section where past sessions group under the
workspace they ran in, with search and pagination, so multi-project use no
longer depends on memory or chronology.

## ADDED Requirements

### Requirement: The sidebar renders a Workspaces section header
The session region of the sidebar SHALL open with a Workspaces header
carrying the section label, a search toggle, and a new-workspace action. The
header SHALL NOT duplicate the global nav tabs or the settings entry.

#### Scenario: section header renders
- **WHEN** the app shell renders on any view
- **THEN** the session region shows the Workspaces header with search and
  new-workspace affordances

### Requirement: Sessions group under the workspace they ran in
The session list SHALL render collapsible groups keyed by the workspace
recorded on each session. A session without a recorded workspace SHALL
appear under an "Ungrouped" group. Group membership is fixed at the
session's first mirrored turn and SHALL NOT follow later workspace switches.

#### Scenario: sessions split across two workspaces
- **WHEN** the sessions payload contains sessions stamped with workspace A
  and workspace B
- **THEN** the sidebar renders two groups and each session appears only
  under its stamped workspace

#### Scenario: workspace switch does not re-group the live session
- **WHEN** the user switches the runtime workspace mid-conversation and then
  sends a turn
- **THEN** the session remains listed under the workspace it started in

#### Scenario: legacy session without a workspace
- **WHEN** a session row has no recorded workspace
- **THEN** it renders under the Ungrouped group

### Requirement: Workspace groups paginate with a show-more expander
Each group SHALL render a capped preview of its most recently updated
sessions and a "Show N more" expander revealing the rest. The cap applies
per group, and an expanded group SHALL offer collapse back to the preview.

#### Scenario: group exceeds the preview cap
- **WHEN** a workspace group holds more sessions than the preview cap
- **THEN** the group shows the newest sessions up to the cap plus a
  show-more control listing the remaining count, and expanding it reveals
  the rest in place

### Requirement: Search filters sessions across groups
Activating search in the Workspaces header SHALL filter session rows by
title substring (case-insensitive) across all groups, hiding groups with no
matches. Clearing the query restores the grouped list. Search is
client-side over the already-loaded sessions payload.

#### Scenario: query narrows to matching sessions
- **WHEN** the user types a title fragment into the search field
- **THEN** only sessions whose title contains the fragment remain, grouped
  as before, and groups without matches are hidden

#### Scenario: clearing the query
- **WHEN** the user clears the search field
- **THEN** the full grouped list is restored

### Requirement: The new-workspace action reuses the workspace switch contract
The header's new-workspace action SHALL collect an absolute path and submit
it through the existing workspace-switch message — server validation, the
mid-conversation confirmation, the runtime restart, and the
`workspace_changed` broadcast all behave exactly as the composer control.
An invalid path SHALL surface the server/client validation error without
switching.

#### Scenario: valid path switches the runtime workspace
- **WHEN** the user enters an absolute path for an existing directory and
  confirms
- **THEN** the runtime switches to it and the sidebar reflects the new
  current workspace

#### Scenario: invalid path is rejected without switching
- **WHEN** the user enters a relative or non-existent path
- **THEN** a validation error is shown and the runtime workspace is
  unchanged
