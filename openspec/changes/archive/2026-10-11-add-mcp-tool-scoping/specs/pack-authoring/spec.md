# pack-authoring Delta (add-mcp-tool-scoping)

## MODIFIED Requirements

### Requirement: MCP entries are picked from the market catalog

The author SHALL select MCP entries from the registry-sourced entries of the cell's market catalog; the draft SHALL store a registry-name reference (with the entry's display metadata for preview). A draft MCP reference MAY carry a tool allowlist: a list of tool leaf names narrowing the reference to exactly those tools. The editor SHALL offer the allowlist as a picker over the server's tool list as served by the market catalog; free-form tool-name entry SHALL be rejected by the editor the same way free-form endpoints are. A reference without an allowlist keeps the server's full tool surface. The v1 editor SHALL NOT offer a free-form endpoint or command entry for MCP entries.

#### Scenario: Picker lists registry servers

- **WHEN** the author opens the MCP picker
- **THEN** the registry-sourced market entries visible to the author are listed and selectable

#### Scenario: No free-form MCP entry

- **WHEN** the author composes the MCP list of a draft
- **THEN** no field accepts a URL or command configuration

#### Scenario: Tool allowlist narrows a reference

- **WHEN** the author picks a registry server and selects three of its listed tools as the reference's allowlist, then saves the draft
- **THEN** the entry persists with the registry-name reference plus exactly those three tool leaf names, and the editor previews the narrowed tool count

#### Scenario: Absent allowlist keeps the full surface

- **WHEN** the author saves an MCP reference without selecting tools
- **THEN** the entry persists with no allowlist and the pack's later runtime behavior for that server is the full tool surface

#### Scenario: Tool names come from the picker, not typing

- **WHEN** the author attempts to enter a tool name that is not in the catalog-served tool list for that server
- **THEN** the editor rejects the entry instead of accepting a free-form name

## ADDED Requirements

### Requirement: Resource declarations may narrow tools per role

An agent entry's resource declaration MAY carry an `mcpTools` dimension: a mapping from the draft's own MCP references to tool leaf names. The declaration SHALL only narrow — a role's tool set SHALL be a subset of the pack-level allowlist for that reference (or of the server's full list when the pack declares none); a role SHALL NOT widen a pack-level allowlist. Names SHALL reference only the draft's own MCP entries, and tool names SHALL exist within the referenced entry's declared allowlist or its catalog-served tool list. An absent `mcpTools` dimension means the role uses the pack-level allowlist for every reference; a present-but-empty mapping for a server yields no tools for that server to that role. The same dimension semantics as skills and MCP references apply: foreign names are caught before publish, dimensions scope independently.

#### Scenario: Per-role tool narrowing validates

- **WHEN** a role's declaration maps one of the draft's MCP references to two tool names that appear in that reference's allowlist, and the author saves
- **THEN** the entry persists and the role's later focused runtime exposes only those two tools of that server

#### Scenario: Widening beyond the pack-level allowlist is caught

- **WHEN** a role's declaration names a tool that the pack-level allowlist for that reference excludes, and the author attempts to publish
- **THEN** validation blocks the publish naming the role, the reference, and the offending tool

#### Scenario: Foreign server name in mcpTools is caught

- **WHEN** a role's declaration maps a server name that is not one of the draft's own MCP references
- **THEN** validation blocks the publish naming the offending role and server

#### Scenario: Absent dimension inherits the pack-level allowlist

- **WHEN** a role's declaration omits the mcpTools dimension while the pack declares an allowlist for a reference
- **THEN** the role's focused runtime uses that reference's pack-level allowlist exactly

### Requirement: Publish validates tool allowlists against the registry

Publishing a draft SHALL validate every declared tool leaf name against the referenced registry server's known tool surface, and every allowlist against the server's commercial surface when the server is surface-registered. A name absent from the registry's tool snapshot SHALL fail the publish naming the server and the unknown tools, unless a live probe of the server's tool list confirms the name (snapshot staleness fallback). For a surface-registered server, any declared tool outside the server's commercial set SHALL fail the publish naming the out-of-surface tools, regardless of probe results. A reference bound to a local (non-registry) server name is exempt from both checks — its tool names are validated only where the local server's surface is knowable, and otherwise accepted as declared.

#### Scenario: Unknown tool name fails publish

- **WHEN** the author publishes a draft whose MCP reference declares a tool name absent from the registry's tool snapshot for that server and a live probe also does not list it
- **THEN** the publish is rejected naming the server and the unknown tool name, and no version is frozen

#### Scenario: Snapshot staleness falls back to a live probe

- **WHEN** a declared tool name is missing from the registry snapshot but the server's live tool list contains it
- **THEN** the publish passes the name check and the version freezes

#### Scenario: Out-of-commercial-surface tool fails publish

- **WHEN** the author publishes a reference to a surface-registered server declaring a tool that the server's surface marks internal
- **THEN** the publish is rejected naming the out-of-surface tool, even though the tool exists

#### Scenario: Packs without allowlists publish unchanged

- **WHEN** the author publishes a draft whose MCP references declare no tool allowlists
- **THEN** the publish behaves exactly as before this change — no tool-surface validation applies
