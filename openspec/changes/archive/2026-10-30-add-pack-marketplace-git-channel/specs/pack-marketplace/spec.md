## ADDED Requirements

### Requirement: CodeBuddy-compatible marketplace repository

The facet service SHALL be able to project its listed packs into a marketplace repository in the CodeBuddy/WorkBuddy plugin-marketplace format — a repository root carrying `.codebuddy-plugin/marketplace.json` and, per listed pack, a plugin directory containing the pack's skills as skill directories (each with a `SKILL.md` and any auxiliary files) and its agents as plugin agents. The repository SHALL be the distribution form for clients that cannot recursively fetch plugin files over HTTP; it SHALL NOT replace or alter the existing Claude-format endpoint.

Listing admission SHALL be the same single source the browse face and the Claude endpoint consume — public, non-unlisted, and curated (`category` non-empty or `featured` true), unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing (override semantics). Private and unlisted packs SHALL be absent from the repository, and no pack that the browse face hides SHALL appear.

MCP references SHALL appear in the plugin body as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration. Each marketplace entry SHALL carry the pack's current published version, so a client's version-pinned install stays reproducible.

Snapshot generation SHALL be self-validating: the produced manifest SHALL parse, every entry SHALL resolve to a present directory, and no file path SHALL escape its plugin directory. A snapshot that fails validation SHALL NOT be published, and the previously published snapshot SHALL remain intact (last-good).

The repository SHALL reflect publish, unpublish, and curation changes within one refresh cycle, and that refresh bound SHALL be stated in the channel's operator documentation.

#### Scenario: Curated pack installs from the repository

- **WHEN** a client adds the marketplace repository by its Git address and installs a listed plugin
- **THEN** the plugin's skills and agents are materialized from the repository's own files, with no further network fetch of plugin content
- **AND** the installed version equals the version the marketplace manifest declares

#### Scenario: Non-public packs never reach the repository

- **WHEN** a pack is private or unlisted
- **THEN** it is absent from the generated manifest and its plugin directory is absent from the repository

#### Scenario: Curation drives admission, whitelist overrides

- **WHEN** a public non-unlisted pack has an empty `category` and a false `featured` flag, and no operator whitelist is set
- **THEN** the pack is absent from the generated manifest
- **AND** when `FACET_MARKETPLACE_PACK_IDS` lists that pack id, the pack is present

#### Scenario: MCP stays guidance in the repository too

- **WHEN** a listed pack declares MCP server references
- **THEN** the plugin's guidance text names each endpoint and the credential requirement
- **AND** the plugin's manifest and files contain no MCP server configuration and no credential material

#### Scenario: Failed snapshot keeps the last good one

- **WHEN** snapshot generation produces a manifest that fails validation (unparseable, missing entry directory, or an escaping path)
- **THEN** nothing is published and the previously published snapshot remains the one clients see
- **AND** the failure is reported as a failure, not as a successful refresh

#### Scenario: Path escape is refused

- **WHEN** a pack's file list contains an absolute path, a `..` segment, a drive letter, or a NUL byte
- **THEN** the snapshot is rejected rather than sanitized silently
