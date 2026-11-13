## MODIFIED Requirements

### Requirement: The new-workspace action reuses the workspace switch contract
The header's new-workspace action SHALL collect a **project name** as its primary input: submitting a name calls `POST /api/projects` (openspec: project-workspace) and submits the returned absolute path through the existing workspace-switch message — server validation, the mid-conversation confirmation, the runtime restart, and the `workspace_changed` broadcast all behave exactly as the composer control. The action SHALL also offer an advanced mode that collects an absolute path to an existing directory, submitted through the same switch contract with unchanged validation; an invalid path in either mode SHALL surface the validation error without switching. The section's user-facing label SHALL read 项目 (Projects) via the i18n bundle; the underlying keys, session grouping by workspace stamp, and every other affordance of the section are unchanged.

#### Scenario: valid path switches the runtime workspace
- **WHEN** the user enters an absolute path for an existing directory in advanced mode and confirms
- **THEN** the runtime switches to it and the sidebar reflects the new current workspace

#### Scenario: invalid path is rejected without switching
- **WHEN** the user enters a relative or non-existent path in advanced mode
- **THEN** a validation error is shown and the runtime workspace is unchanged

#### Scenario: creating a project by name switches to it

- **WHEN** the user enters a name such as「季度报告」and confirms
- **THEN** the client SHALL create the project via `POST /api/projects` and switch the runtime workspace to the returned path through the existing switch chain (validation, mid-conversation confirmation, restart, broadcast)
- **AND** the sidebar SHALL reflect the new project as the current workspace

#### Scenario: project creation failure surfaces without switching

- **WHEN** `POST /api/projects` rejects the name (HTTP 400) or fails
- **THEN** the popover SHALL surface the error and the runtime workspace SHALL be unchanged
