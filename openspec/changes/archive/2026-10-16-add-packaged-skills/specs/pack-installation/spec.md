# pack-installation — Delta

## MODIFIED Requirements

### Requirement: One action materializes the whole pack

Subscribing to a pack SHALL be a single user action that installs the subscribed version's snapshot: every skill becomes available for invocation through the platform's existing skill pipeline, every MCP reference becomes an installed connectable server, and every agent entry becomes selectable in the agent picker. No part of the install SHALL require per-part user actions. A pack whose skills carry executable-content files (scripts) SHALL present exactly one upfront acknowledgment naming the count of script files before the install proceeds — one acknowledgment for the whole pack, never per part; a pack without script files keeps the previous zero-friction flow. A skill entry with an auxiliary file set SHALL materialize as a complete directory tree (skill document plus auxiliary files) so the runtime resolves the skill's resources against its own directory; an entry without one materializes exactly as the single-file skill of the previous contract.

#### Scenario: Full pack installs in one action

- **WHEN** a user subscribes to a pack with two skills, one MCP reference, and one agent
- **THEN** after the single subscribe action completes, both skills are invocable, the MCP server is installed and connectable, and the agent appears in the picker

#### Scenario: Multi-file skill materializes as a tree

- **WHEN** a subscribed pack contains a skill whose entry carries `references/method.md` and `scripts/run.py`
- **THEN** the installed skill's directory contains the skill document and both auxiliary files at their relative paths, and a conversation referencing them resolves the paths against the skill's directory

#### Scenario: Script-bearing pack asks once, upfront

- **WHEN** a user subscribes to a pack whose skills carry three script files in total
- **THEN** the install flow presents one acknowledgment naming three script files, and confirming it installs the whole pack
- **AND** an install request for a script-bearing pack that arrives without the confirmation marker is rejected server-side and installs nothing

#### Scenario: Script-free pack keeps the zero-friction flow

- **WHEN** a user subscribes to a pack whose skills carry no executable-content files
- **THEN** the install proceeds exactly as before with no acknowledgment step

### Requirement: Skill conflict policy — never overwrite foreign content

A pack skill whose name collides with an existing skill not owned by that pack (user-created or from another pack) SHALL be skipped and reported with the collision reason; the existing skill SHALL be untouched. Skills owned by the pack itself SHALL be replaced by the pack's current content on install and upgrade — body, auxiliary file set, and stored frontmatter replaced wholesale, with files removed in the new version swept from the materialized tree. The cell SHALL track which skills each installed pack owns.

#### Scenario: Name collision skips and reports

- **WHEN** a pack contains a skill `contract-review` and the subscriber already has a user-created skill with that name
- **THEN** the install completes with that skill skipped, the existing skill is unchanged, and the report names the collision

#### Scenario: Upgrade replaces the pack's own skill

- **WHEN** a subscriber upgrades a pack whose new version changed a skill the pack had installed
- **THEN** the skill is updated to the new version's content

#### Scenario: Upgrade sweeps dropped files

- **WHEN** a pack's new version removes an auxiliary file that the previous version had installed
- **THEN** the materialized skill directory no longer contains that file

### Requirement: Install report

Every subscribe, upgrade, and unsubscribe action SHALL produce a per-part report stating, for each skill, MCP reference, and agent, one of: installed, reused, replaced, skipped or unavailable with a reason, bound or awaiting-local-binding with guidance, or removed. The report's skill rows SHALL additionally state the entry's auxiliary file count and name the entry's script files, so a subscriber can see what file content arrived. The UI SHALL show the report after the action.

#### Scenario: Partial failure is visible

- **WHEN** a subscribe completes with one skill skipped for a name collision and one MCP reference unresolvable
- **THEN** the report lists every part with its outcome, and the failed parts carry their reasons

#### Scenario: Binding states are visible

- **WHEN** a subscribe completes with one MCP reference bound to a local server and another awaiting-local-binding
- **THEN** the report lists both with their binding outcomes, and the awaiting part names what the user can do to activate it

#### Scenario: File content is disclosed per skill

- **WHEN** a subscribe completes with a skill that installed six auxiliary files, two of them scripts
- **THEN** that skill's report row states six files and names the two script files

### Requirement: Unsubscribe removes pack-owned content only

Unsubscribing SHALL remove the pack's owned skills and agent entries. It SHALL warn before removing a pack skill whose content the user modified after installation — modified meaning the body, the auxiliary file set, or the stored frontmatter diverges from the installed version's manifest. It SHALL NOT remove MCP server configurations, which are shared utilities that manual installs and other packs may also reference.

#### Scenario: Uninstall removes skills and agent

- **WHEN** a subscriber unsubscribes from a pack with two skills and one agent
- **THEN** the pack-owned skills disappear from the skill list and the agent disappears from the picker

#### Scenario: Modified skill warns before removal

- **WHEN** a subscriber edited a pack skill's content and then unsubscribes
- **THEN** the uninstall flow warns that the modified skill will be lost and requires explicit confirmation

#### Scenario: Edited auxiliary file also warns

- **WHEN** a subscriber edited one auxiliary file of a pack skill and then unsubscribes
- **THEN** the uninstall flow warns that the modified skill will be lost, same as a body edit

#### Scenario: MCP configurations survive unsubscribe

- **WHEN** a subscriber unsubscribes from a pack whose MCP reference was installed by the subscribe action
- **THEN** the MCP server configuration remains installed and connectable
