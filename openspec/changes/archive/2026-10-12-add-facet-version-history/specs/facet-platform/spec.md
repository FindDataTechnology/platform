## MODIFIED Requirements

### Requirement: The facet surface carries a creator console

The facet web shell SHALL provide a creator console at `#/mine` for signed-in users in the creator group: it lists the packs the viewer authored (with version history), offers unpublish (the unlisted semantics of openspec: pack-marketplace), toggles pack visibility between public and private (openspec: pack-visibility), and offers a publish-from-manifest entry that submits a manifest to the same identity-gated publish endpoint the cell-assembled flow uses, surfacing validation errors verbatim. The creator console's version history SHALL render through the same version-list presentation the public detail view uses (openspec: pack-marketplace, Browse, search, and inspect): one shared component serves both surfaces, its rows carrying version number, publish time, publisher, the version's note when present, and per-version manifest/skill links — the author surface and the public surface cannot drift. Cell-side surfaces — installed-packs management and cell-assembled drafts — SHALL remain 壹座-only; the facet install surface keeps its guided refusal.

#### Scenario: the author sees their packs

- **WHEN** a signed-in creator opens `#/mine`
- **THEN** the packs they authored are listed with latest version and visibility state, and no pack authored by someone else appears

#### Scenario: publish from manifest on the facet surface

- **WHEN** the creator submits a manifest through the creator console and the manifest is valid
- **THEN** a new pack (or a new version of the named pack) is published under their identity
- **AND** the console surfaces the returned identifier and version

#### Scenario: publish from manifest surfaces validation errors

- **WHEN** the creator submits a manifest that fails validation
- **THEN** the console shows the validation errors verbatim and nothing is stored

#### Scenario: install stays a base surface

- **WHEN** any visitor reaches the facet creator console
- **THEN** it offers no cell install action, consistent with the install surface's guided refusal

#### Scenario: version history shares the public presentation

- **WHEN** a creator expands a pack's version history on `#/mine`
- **THEN** the rows render through the same version-list presentation the public detail view uses, showing note-when-present and the same per-version manifest/skill links
- **AND** an update to the shared presentation changes both surfaces together
