## MODIFIED Requirements

### Requirement: The sidebar renders a Workspaces section header
The session region of the sidebar SHALL open with a Workspaces header
carrying the section label, a search toggle, and a new-workspace action. The
header SHALL NOT duplicate the global nav tabs or the settings entry. The same
header row SHALL also carry a project switcher rendered above the group list:
one control, showing the CURRENT project's display name on web (the read-time
默认项目 fallback when no project is current) and the current workspace path on
desktop. The switcher SHALL NOT render a second session list duplicated from
the groups, and SHALL NOT restate the groups' rows or counts; it selects a
project context only.

#### Scenario: section header renders
- **WHEN** the app shell renders on any view
- **THEN** the session region shows the Workspaces header with search and
  new-workspace affordances, plus one project switcher above the group list

#### Scenario: switcher labels the current project on web
- **WHEN** the web surface renders the Workspaces header while a project is current
- **THEN** the switcher shows that project's display name, never an absolute path

#### Scenario: switcher labels the current workspace on desktop
- **WHEN** the desktop surface renders the Workspaces header
- **THEN** the switcher shows the current workspace path, preserving desktop's existing workspace-path semantics

### Requirement: Sessions group under the workspace they ran in
The session list SHALL render collapsible groups, with the grouping key forked by surface. On the web surface the key SHALL be the session's project attribution (openspec: project-container): sessions stamped with a project id group under the project's display name, and sessions without one group under the read-time 默认项目 fallback; the group header SHALL show the project name, never the absolute path (the path remains visible as a per-project detail, e.g. tooltip or project view). On the desktop surface the key SHALL remain the workspace path recorded on each session, with an "Ungrouped" fallback for unstamped rows, exactly as before. On both surfaces group membership is fixed at the session's first mirrored turn and SHALL NOT follow later workspace or project switches. The project switcher SHALL NOT alter this rule: selecting a different project SHALL NOT re-group, move, or re-attribute any existing session — the selection only sets the project context used for sessions started afterwards and the target of the workspace switch contract.

#### Scenario: sessions split across two workspaces
- **WHEN** the sessions payload contains sessions stamped with workspace A and workspace B and neither carries a project attribution (the desktop surface, or web rows predating attribution)
- **THEN** each session appears only under its stamped workspace group (desktop) or the 默认项目 fallback (web), and no session appears twice

#### Scenario: sessions split across two projects on web
- **WHEN** the web surface lists sessions attributed to project A and project B
- **THEN** the sidebar renders two groups titled by the projects' display names, and each session appears only under its attributed project

#### Scenario: absolute paths do not front the web sidebar
- **WHEN** any web group renders
- **THEN** the group label shows the project name (or 默认项目), not a filesystem path

#### Scenario: desktop grouping is unchanged
- **WHEN** the desktop surface lists the same sessions payload
- **THEN** groups are keyed by workspace path with the Ungrouped fallback, as prior to this change

#### Scenario: workspace switch does not re-group the live session
- **WHEN** the user switches the runtime workspace mid-conversation and then sends a turn
- **THEN** the session remains listed under the group it started in

#### Scenario: legacy session without a workspace
- **WHEN** a session row has no recorded workspace and no project attribution
- **THEN** on web it renders under the 默认项目 group; on desktop under Ungrouped

#### Scenario: selecting a project in the switcher does not re-group history
- **WHEN** the user selects a different project in the switcher while the sidebar already lists sessions from the previously current project
- **THEN** every existing session stays under the group it was already listed in, and only subsequently started sessions belong to the newly selected project

## ADDED Requirements

### Requirement: Project switcher is a visible control with a safe degraded state
The project switcher SHALL open a picker listing the user's projects by display name (read from the existing projects API) plus the 默认项目 fallback bucket, and SHALL offer the existing new-project action — the same `set_workspace` name→materialize contract already provided by the new-workspace action, with no new server contract. On the web surface the picker SHALL show display names only and SHALL NOT show absolute paths; on the desktop surface the path form is permitted. Selecting an entry SHALL set the project context used for new sessions and for the workspace switch contract, and SHALL NOT duplicate the group list (no session rows and no per-group counts inside the picker). If the projects read fails, the switcher SHALL render the 默认项目 label and remain usable, never a blank, hidden, or disabled header. Group ordering, the preview cap, search, and pagination SHALL be unchanged by this control.

#### Scenario: picker lists projects and offers new-project
- **WHEN** the user opens the project switcher
- **THEN** the picker lists each project by display name plus the 默认项目 bucket, and offers the new-project action that reuses the existing name→materialize switch contract

#### Scenario: picker shows no absolute paths on web
- **WHEN** the user opens the project switcher on the web surface
- **THEN** every entry is labelled by project display name or 默认项目, and no absolute path is rendered

#### Scenario: projects read failure degrades safely
- **WHEN** the projects list read fails or returns nothing
- **THEN** the switcher renders the 默认项目 label and stays openable and usable, and the session groups still render as before

#### Scenario: switcher and group list cannot disagree
- **WHEN** a session is open and the sidebar renders both the switcher and the session groups
- **THEN** the switcher's current project and the leading group's project resolve from the same single source of the current project's identity, so the two can never show different projects

#### Scenario: switcher does not displace existing header affordances
- **WHEN** the project switcher is present in the Workspaces header
- **THEN** the search toggle, the new-workspace action, the preview cap, and pagination still behave as before
