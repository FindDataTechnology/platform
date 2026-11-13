## MODIFIED Requirements

### Requirement: MCP entries are picked from the market catalog

The author SHALL select MCP entries from the registry-sourced entries of the cell's market catalog; the draft SHALL store a registry-name reference (with the entry's display metadata for preview). A draft MCP reference MAY carry a tool allowlist: a list of tool leaf names narrowing the reference to exactly those tools. The editor SHALL offer the allowlist as a picker over the server's tool list as served by the market catalog; free-form tool-name entry SHALL be rejected by the editor the same way free-form endpoints are. A draft reference MAY instead be marked `fullSurface` with a reason, declaring that the pack intentionally uses the server's whole tool surface. A draft MAY be saved with neither (work in progress), but publishing requires one of the two (openspec: pack-authoring, Publish requires an explicit tool face and validates it). The v1 editor SHALL NOT offer a free-form endpoint or command entry for MCP entries.

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
- **THEN** the entry persists as a draft with no allowlist; its published runtime behavior is the full tool surface only if the author marks it `fullSurface` with a reason before publishing

#### Scenario: Tool names come from the picker, not typing

- **WHEN** the author attempts to enter a tool name that is not in the catalog-served tool list for that server
- **THEN** the editor rejects the entry instead of accepting a free-form name

## REMOVED Requirements

### Requirement: Publish validates tool allowlists against the registry

**Reason**: Superseded by "Publish requires an explicit tool face and validates it". The previous requirement validated the names an author happened to declare, but accepted a reference that declared nothing — which is how every published pack except one ended up mounting a full server surface. The new requirement keeps every validation the old one performed and adds the missing gate.

**Migration**: Packs already published keep installing and running unchanged. The next publish of any pack must either declare `allowTools` (derivable from the skill bodies — see the authoring-repo change `pack-tool-declaration-backfill`) or carry `fullSurface: true` with a reason. No consumer action is required.

## ADDED Requirements

### Requirement: Publish requires an explicit tool face and validates it

Every MCP reference in a published manifest SHALL carry exactly one of: a non-empty `allowTools` list of tool leaf names, or `fullSurface: true` together with a non-empty `fullSurfaceReason`. A reference carrying neither SHALL fail the publish, naming the pack, the server, and both remedies (declare the tools, or mark the reference full-surface with a reason). A reference carrying both SHALL fail as a shape error.

Tool-level closure SHALL be enforced at publish: every `mcp__<server>__<tool>` reference extracted from the pack's skill bodies SHALL fall inside that server reference's `allowTools`. A `fullSurface` reference is exempt from this closure (its face is the whole surface by definition). A named tool outside the declaration SHALL fail the publish naming the server, the tool, and the skills that reference it.

Declared names SHALL be validated against the referenced registry server's known tool surface, and every allowlist against the server's commercial surface when the server is surface-registered. A name absent from the registry's tool snapshot SHALL fail the publish naming the server and the unknown tools, unless a live probe of the server's tool list confirms the name (snapshot staleness fallback). When the live probe cannot be performed — the endpoint refuses, is unreachable, or answers with a billing or authorization failure — the missing names are UNRESOLVED, never confirmed-absent: the publish SHALL still be refused, and the rejection SHALL state that the names could not be confirmed and name the concrete next step (refresh the registry entry's tool-list snapshot, then publish again, or drop the names) instead of asserting the tools do not exist. For a surface-registered server, any declared tool outside the server's commercial set SHALL fail the publish naming the out-of-surface tools, regardless of probe results. A reference bound to a local (non-registry) server name is exempt from existence and commercial checks — its tool names are validated only where the local server's surface is knowable, and otherwise accepted as declared.

#### Scenario: Undeclared reference fails publish

- **WHEN** the author publishes a draft whose `fd-daas-mcp` reference carries neither `allowTools` nor `fullSurface`
- **THEN** the publish is rejected naming the pack and `fd-daas-mcp`, and the reason lists both remedies

#### Scenario: Both declarations fail as a shape error

- **WHEN** a reference carries both a non-empty `allowTools` and `fullSurface: true`
- **THEN** the publish is rejected naming the reference and the conflict

#### Scenario: Full-surface reference publishes with a reason

- **WHEN** a reference is marked `fullSurface: true` with a non-empty reason
- **THEN** the publish passes the tool-face gate and the version freezes

#### Scenario: Full-surface reference without a reason fails

- **WHEN** a reference is marked `fullSurface: true` with an empty or missing reason
- **THEN** the publish is rejected naming the reference and the missing reason

#### Scenario: Named tool outside the declaration fails publish

- **WHEN** a skill body names `mcp__fd-quant__summarize_drawdown` while the `fd-quant` reference declares only `compute_sma` and `summarize_return`
- **THEN** the publish is rejected naming the server, the tool, and the referencing skills

#### Scenario: Full-surface reference is exempt from closure

- **WHEN** a skill body names a `law-bench` tool and the `law-bench` reference is marked `fullSurface`
- **THEN** the tool-level closure check does not block the publish

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

#### Scenario: An unlisted server skips commercial closure

- **WHEN** the author publishes a reference declaring tools for a server the registry has not surface-registered
- **THEN** no commercial-closure check applies to that reference (only the existence check does), and the publish proceeds on the name check alone

#### Scenario: Local binding stays exempt

- **WHEN** a reference binds a local (non-registry) server name and declares tools
- **THEN** existence and commercial checks do not apply, and the publish proceeds as declared
