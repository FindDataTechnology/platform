# pack-authoring Delta (publish-tool-gate-probe-degradation)

## MODIFIED Requirements

### Requirement: Publish validates tool allowlists against the registry

Publishing a draft SHALL validate every declared tool leaf name against the referenced registry server's known tool surface, and every allowlist against the server's commercial surface when the server is surface-registered. A name absent from the registry's tool snapshot SHALL fail the publish naming the server and the unknown tools, unless a live probe of the server's tool list confirms the name (snapshot staleness fallback). When the live probe cannot be performed — the endpoint refuses, is unreachable, or answers with a billing or authorization failure — the missing names are UNRESOLVED, never confirmed-absent: the publish SHALL still be refused, and the rejection SHALL state that the names could not be confirmed and name the concrete next step (refresh the registry entry's tool-list snapshot, then publish again, or drop the names) instead of asserting the tools do not exist. For a surface-registered server, any declared tool outside the server's commercial set SHALL fail the publish naming the out-of-surface tools, regardless of probe results. A reference bound to a local (non-registry) server name is exempt from both checks — its tool names are validated only where the local server's surface is knowable, and otherwise accepted as declared.

#### Scenario: Unknown tool name fails publish

- **WHEN** the author publishes a draft whose MCP reference declares a tool name absent from the registry's tool snapshot for that server and a live probe also does not list it
- **THEN** the publish is rejected naming the server and the unknown tool name, and no version is frozen

#### Scenario: Snapshot staleness falls back to a live probe

- **WHEN** a declared tool name is missing from the registry snapshot but the server's live tool list contains it
- **THEN** the publish passes the name check and the version freezes

#### Scenario: An unavailable probe leaves names unresolved, not absent

- **WHEN** a declared tool name is missing from the registry snapshot and the live probe cannot be performed (the endpoint answers a billing or authorization failure, or is unreachable)
- **THEN** the publish is refused with a reason stating the names could not be confirmed rather than that they do not exist
- **AND** the reason names the next step — refresh the registry entry's tool-list snapshot and publish again, or drop the names

#### Scenario: Out-of-commercial-surface tool fails publish

- **WHEN** the author publishes a reference to a surface-registered server declaring a tool that the server's surface marks internal
- **THEN** the publish is rejected naming the out-of-surface tool, even though the tool exists

#### Scenario: Packs without allowlists publish unchanged

- **WHEN** the author publishes a draft whose MCP references declare no tool allowlists
- **THEN** the publish behaves exactly as before this change — no tool-surface validation applies
