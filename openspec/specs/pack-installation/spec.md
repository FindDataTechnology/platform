# pack-installation Specification

## Purpose
What subscribing to a pack does inside the subscriber's cell: one-click materialization of a version snapshot into skills, MCP connections, and agents — with conflict handling, per-part reporting, explicit updates, and uninstall semantics.

## Requirements

### Requirement: One action materializes the whole pack

Subscribing to a pack SHALL be a single user action that installs the subscribed version's snapshot: every skill becomes available for invocation through the platform's existing skill pipeline, every MCP reference becomes an installed connectable server, and every agent entry becomes selectable in the agent picker. No part of the install SHALL require per-part user actions.

#### Scenario: Full pack installs in one action

- **WHEN** a user subscribes to a pack with two skills, one MCP reference, and one agent
- **THEN** after the single subscribe action completes, both skills are invocable, the MCP server is installed and connectable, and the agent appears in the picker

### Requirement: Installed content is a version snapshot

Installed skills, MCP references, and agent entries SHALL come from the manifest of the version that was subscribed. They SHALL keep working unchanged regardless of later marketplace events: the author publishing newer versions, or unpublishing the pack entirely.

#### Scenario: Author's new version does not propagate

- **WHEN** the author publishes version 2 and a subscriber installed version 1
- **THEN** the subscriber's skills, MCP connections, and agents still behave exactly as version 1 defined

#### Scenario: Unpublish does not remove installed content

- **WHEN** the author unpublishes a pack that a subscriber installed
- **THEN** the subscriber's installed skills, MCP connections, and agents keep working

### Requirement: Skill conflict policy — never overwrite foreign content

A pack skill whose name collides with an existing skill not owned by that pack (user-created or from another pack) SHALL be skipped and reported with the collision reason; the existing skill SHALL be untouched. Skills owned by the pack itself SHALL be replaced by the pack's current content on install and upgrade. The cell SHALL track which skills each installed pack owns.

#### Scenario: Name collision skips and reports

- **WHEN** a pack contains a skill `contract-review` and the subscriber already has a user-created skill with that name
- **THEN** the install completes with that skill skipped, the existing skill is unchanged, and the report names the collision

#### Scenario: Upgrade replaces the pack's own skill

- **WHEN** a subscriber upgrades a pack whose new version changed a skill the pack had installed
- **THEN** the skill is updated to the new version's content

### Requirement: MCP references resolve through the subscriber's own credentials

Each MCP reference SHALL resolve through the existing registry-market install path using the subscriber's own registry credential; the pack SHALL NOT carry or transfer any secret. A server already installed in the cell SHALL be reused, not duplicated. A reference that cannot be resolved at install time — the server is no longer in the registry catalog, or the subscriber's groups do not grant access to it — SHALL be reported as unavailable in the install report without blocking the other parts.

#### Scenario: Registry MCP installs under the subscriber's credential

- **WHEN** a subscriber without a live registry credential subscribes to a pack with a registry MCP reference
- **THEN** the install routes through the existing connect flow for that credential before the server connects, and the pack carries no secret of any kind

#### Scenario: Already-installed server is reused

- **WHEN** a pack references a registry server the subscriber already installed
- **THEN** the install reuses the existing configuration and the report marks the part as reused

#### Scenario: Missing server is reported, not fatal

- **WHEN** a pack references a registry server that is not in the subscriber's visible market catalog
- **THEN** the rest of the pack installs and the report names the unresolvable reference with its reason

### Requirement: Pack agents run as local personas

A subscribed pack's agent entries SHALL appear in the subscriber's agent picker and, when selected, SHALL run as a local persona in the subscriber's runtime — the platform's currently selected model with the pack persona's behavior — composed with the pack's resource set and the deployment baseline (openspec: pack-agent-scoping): the pack's own skills and MCP references plus the deployment's always-on baseline, not the subscriber's entire installed surface. Switching back to a shipped mode or the built-in agent restores the full surface.

#### Scenario: Pack agent selectable and local

- **WHEN** a subscriber selects a pack's agent and sends a message
- **THEN** the persona runs in the local runtime and can invoke the pack's skills and MCP tools plus the deployment baseline in the same conversation

#### Scenario: Focus follows the existing switch contract

- **WHEN** a subscriber selects or deselects a pack's agent
- **THEN** the focus change applies through the same preset-switch path as before this change (rejected while streaming, applied to the next session, broadcast to clients)

### Requirement: Install report

Every subscribe, upgrade, and unsubscribe action SHALL produce a per-part report stating, for each skill, MCP reference, and agent, one of: installed, reused, replaced, skipped or unavailable with a reason, or removed. The UI SHALL show the report after the action.

#### Scenario: Partial failure is visible

- **WHEN** a subscribe completes with one skill skipped for a name collision and one MCP reference unresolvable
- **THEN** the report lists every part with its outcome, and the failed parts carry their reasons

### Requirement: Updates are explicit

When the marketplace holds a newer version of an installed pack, the installed pack SHALL surface an update affordance showing the installed and latest version numbers. Upgrading SHALL be an explicit user action that materializes the new version under the same conflict policy. The system SHALL NOT propagate new versions automatically, and downgrade SHALL NOT be offered.

#### Scenario: Update badge appears

- **WHEN** the author publishes version 3 and a subscriber has version 2 installed
- **THEN** the subscriber's installed-pack view shows that an update to version 3 is available

#### Scenario: Upgrade is opt-in

- **WHEN** the update affordance is visible and the subscriber does not act
- **THEN** nothing about the installed version 2 changes

### Requirement: Unsubscribe removes pack-owned content only

Unsubscribing SHALL remove the pack's owned skills and agent entries. It SHALL warn before removing a pack skill whose content the user modified after installation. It SHALL NOT remove MCP server configurations, which are shared utilities that manual installs and other packs may also reference.

#### Scenario: Uninstall removes skills and agent

- **WHEN** a subscriber unsubscribes from a pack with two skills and one agent
- **THEN** the pack-owned skills disappear from the skill list and the agent disappears from the picker

#### Scenario: Modified skill warns before removal

- **WHEN** a subscriber edited a pack skill's content and then unsubscribes
- **THEN** the uninstall flow warns that the modified skill will be lost and requires explicit confirmation

#### Scenario: MCP configurations survive unsubscribe

- **WHEN** a subscriber unsubscribes from a pack whose MCP reference was installed by the subscribe action
- **THEN** the MCP server configuration remains installed and connectable

### Requirement: The cell records installed packs

The cell SHALL record each installed pack (identifier, version, per-part state) and expose the list to the user. This installed-pack state — not the gateway's subscription records — is what determines what is materialized in the cell and what the update and unsubscribe flows act on.

#### Scenario: My packs lists versions

- **WHEN** a user with two installed packs opens the installed-packs view
- **THEN** both packs are listed with their installed version numbers and per-part status

### Requirement: Manifest retrieval is server-side

Installing a pack SHALL NOT require the client to transmit the pack manifest. The install endpoint SHALL accept `{packId, version}` and retrieve that version's manifest from the marketplace server-side before running the existing validation and materialization pipeline. A request that still carries a manifest body SHALL continue to be accepted and SHALL be validated by the same rules (rolling compatibility). Retrieval SHALL be performed under the calling user's identity so that private-pack visibility semantics are unchanged. If the manifest cannot be retrieved, the install SHALL fail with a clear error and materialize nothing.

#### Scenario: Client sends only packId and version

- **WHEN** the UI posts `{packId, version}` for a pack whose manifest contains code snippets
- **THEN** the server fetches the manifest from the marketplace, validates it, and materializes the pack exactly as before

#### Scenario: Private pack visibility follows the caller

- **WHEN** a user installs a private pack they are allowed to see
- **THEN** the server-side retrieval is evaluated under that user's identity and succeeds; a user without access gets the same not-found behavior as the market listing

#### Scenario: Retrieval failure installs nothing

- **WHEN** the marketplace is unreachable or the version does not exist
- **THEN** the response reports the failure and no skill, MCP reference, or agent is written

#### Scenario: Body manifest still accepted

- **WHEN** a request includes a manifest body during the compatibility window
- **THEN** it is processed through the identical validation pipeline as a server-retrieved manifest
