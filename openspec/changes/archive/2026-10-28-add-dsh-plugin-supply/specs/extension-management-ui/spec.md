# extension-management-ui Specification (delta)

## ADDED Requirements

### Requirement: dsh plugin bundles are a Settings section

The web UI SHALL mount a Plugins management pane as the Settings modal's `plugins`
section at `/settings/plugins`, as a sibling of the MCP servers and skills sections
and likewise absent from the sidebar navigation tabs. The Plugins section SHALL list
the deployment's whitelisted dsh bundles as a read-only inventory (id, description,
enabled state, and error metadata when present) with an enable/disable toggle per
bundle row, and SHALL offer no install, remove, or edit flows — a hint SHALL state
that bundles are supplied by the deployment.

A toggle SHALL surface the dsh-plugin-supply apply semantics: a toggle refused
while the agent is streaming SHALL render the refusal reason and leave the row's
reported state unchanged; an accepted toggle SHALL indicate it is being applied
(recompose or child restart) and the section SHALL refresh the inventory when
composition settles without requiring a page reload.

#### Scenario: Plugins section appears beside MCP and Skills

- **WHEN** the user opens the Settings modal
- **THEN** navigation SHALL offer MCP servers, skills, and plugins as sibling sections
- **AND** selecting plugins SHALL set the URL to `/settings/plugins` and render the Plugins pane
- **AND** the sidebar SHALL NOT gain a plugins navigation tab

#### Scenario: toggle reflects pending-vs-applied state

- **WHEN** the user flips a bundle's toggle while the runtime is idle
- **THEN** the UI SHALL indicate the change is being applied and SHALL refresh the inventory when composition settles
- **AND** if the apply required a child restart, existing chat sessions SHALL remain usable afterwards

#### Scenario: toggle refused while streaming

- **WHEN** the user attempts a toggle while the shared runtime is streaming
- **THEN** the UI SHALL present the busy refusal reason
- **AND** the row SHALL keep reporting the previous enabled state

#### Scenario: no install surface

- **WHEN** the user views the Plugins section
- **THEN** there SHALL be no install, remove, or edit affordance for bundles
- **AND** a hint SHALL state that bundles are supplied by the deployment

#### Scenario: failed bundle surfaces its error

- **WHEN** a whitelisted bundle carries an activation error
- **THEN** its row SHALL display the error metadata rather than hiding the row
