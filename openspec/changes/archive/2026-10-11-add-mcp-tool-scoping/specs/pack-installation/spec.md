# pack-installation Delta (add-mcp-tool-scoping)

## MODIFIED Requirements

### Requirement: MCP references resolve through the subscriber's own credentials

Each MCP reference SHALL resolve through the existing registry-market install path using the subscriber's own registry credential; the pack SHALL NOT carry or transfer any secret. A server already installed in the cell SHALL be reused, not duplicated. A reference whose name matches a locally installed server row (a user-deployed server, not a registry-market entry) SHALL bind to that local row: the binding is recorded with the pack's installed state, the local row's configuration is neither overwritten nor extended by the install, and no group gate applies to a local binding. A reference that resolves to neither — no registry catalog entry and no local row of that name — SHALL be reported as awaiting-local-binding in the install report without blocking the other parts; it becomes a bound reference when a server of that name is later installed or connected in the cell, with no reinstall of the pack required. A reference that names a registry entry the subscriber cannot use — the server is no longer in the visible catalog, or the subscriber's groups do not grant access — SHALL be reported as unavailable in the install report without blocking the other parts. An allowlist declared on the reference SHALL travel with the resolution: reused, bound, and awaiting-local-binding references all keep their declared tool names in the installed record, to take effect in focused mode (openspec: pack-agent-scoping).

#### Scenario: Registry MCP installs under the subscriber's credential

- **WHEN** a subscriber without a live registry credential subscribes to a pack with a registry MCP reference
- **THEN** the install routes through the existing connect flow for that credential before the server connects, and the pack carries no secret of any kind

#### Scenario: Already-installed server is reused

- **WHEN** a pack references a registry server the subscriber already installed
- **THEN** the install reuses the existing configuration and the report marks the part as reused

#### Scenario: Missing server is reported, not fatal

- **WHEN** a pack references a registry server that is not in the subscriber's visible market catalog and no local server of that name is installed
- **THEN** the rest of the pack installs and the report names the unresolvable reference with its reason

#### Scenario: Local same-name row binds without overwriting

- **WHEN** a pack references a server name that exists in the cell as a user-deployed (non-registry) server row
- **THEN** the install records a binding to that local row, the local row's configuration is untouched, and the report marks the part as bound

#### Scenario: Unresolved local name awaits binding

- **WHEN** a pack references a server name with neither a registry catalog entry nor an installed local row
- **THEN** the install completes for the other parts and the report marks the reference as awaiting-local-binding with guidance to install or connect a server of that name

#### Scenario: Later local install activates the binding

- **WHEN** an installed pack holds an awaiting-local-binding reference and the user installs or connects a server of that name
- **THEN** the reference becomes bound on the next composition without any reinstall of the pack

#### Scenario: Local binding carries no group gate

- **WHEN** a pack references a local server name and the subscriber holds none of the groups any registry gate would consult
- **THEN** the local binding still records and the local server remains usable through the pack's roles

### Requirement: Install report

Every subscribe, upgrade, and unsubscribe action SHALL produce a per-part report stating, for each skill, MCP reference, and agent, one of: installed, reused, replaced, skipped or unavailable with a reason, bound or awaiting-local-binding with guidance, or removed. The UI SHALL show the report after the action.

#### Scenario: Partial failure is visible

- **WHEN** a subscribe completes with one skill skipped for a name collision and one MCP reference unresolvable
- **THEN** the report lists every part with its outcome, and the failed parts carry their reasons

#### Scenario: Binding states are visible

- **WHEN** a subscribe completes with one MCP reference bound to a local server and another awaiting-local-binding
- **THEN** the report lists both with their binding outcomes, and the awaiting part names what the user can do to activate it
