## MODIFIED Requirements

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), `#/mcp` (MCP service catalog), plus identity-conditional views — `#/mine` (creator console, visible to signed-in users) and `#/curate` (curation board, visible to admins). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency. A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell without any routing-context ancestor; a host-side navigation affordance that only makes sense inside 壹座 SHALL be suppressible by the shell without altering the borrowed view's data behavior. A conditional view's tab SHALL appear only when the viewer's identity grants it; navigating to a conditional hash without the grant SHALL fall back to the intro landing (the data plane rejects the calls anyway).

#### Scenario: deep link and refresh

- **WHEN** a visitor opens `#/mcp` directly, or reloads while on `#/packs`
- **THEN** the matching view renders with its tab active

#### Scenario: tab and hash stay in sync

- **WHEN** a visitor switches to the packs market tab
- **THEN** the location hash becomes `#/packs` and a reload keeps that view

#### Scenario: unknown hash falls back

- **WHEN** the location hash is unknown or empty
- **THEN** the intro view renders as the landing

#### Scenario: borrowed view needs no routing context

- **WHEN** the packs market view mounts on the facet shell and public packs exist
- **THEN** pack cards render and the view is interactive (search, detail dialog)
- **AND** no routing provider is present anywhere in the facet shell, and no host-only navigation affordance renders

#### Scenario: conditional tabs follow identity

- **WHEN** an anonymous visitor, a signed-in creator, and an admin each load the shell
- **THEN** the anonymous visitor sees only the three public tabs; the creator additionally sees the creator-console tab (`#/mine`); the admin additionally sees the curation tab (`#/curate`)

## ADDED Requirements

### Requirement: The facet surface carries a creator console

The facet web shell SHALL provide a creator console at `#/mine` for signed-in users in the creator group: it lists the packs the viewer authored (with version history), offers unpublish (the unlisted semantics of openspec: pack-marketplace), toggles pack visibility between public and private (openspec: pack-visibility), and offers a publish-from-manifest entry that submits a manifest to the same identity-gated publish endpoint the cell-assembled flow uses, surfacing validation errors verbatim. Cell-side surfaces — installed-packs management and cell-assembled drafts — SHALL remain 壹座-only; the facet install surface keeps its guided refusal.

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

### Requirement: Curation is a facet-admin surface

The facet web shell SHALL provide a curation board at `#/curate` for admins: it lists all packs (including unlisted and private), lets the admin set a pack's curation category and featured flag inline, and reads back the current state. Non-admins SHALL NOT see the tab; the curation write endpoint SHALL reject them. Curation SHALL be presentation-level only: it never changes pack visibility, content, or installability.

#### Scenario: admin curates from the board

- **WHEN** an admin sets a category and features a pack on the curation board
- **THEN** the market listing shows that pack under the category filter and in the featured rail, and the pack's detail carries the category

#### Scenario: non-admin cannot curate

- **WHEN** a non-admin calls the curation endpoint directly
- **THEN** the request is rejected and no curation state changes

### Requirement: Pack usage is readable on the facet surface

The facet service SHALL expose per-pack usage aggregates (weekly active users and rounds) on its curation board by proxying the platform gateway's usage aggregate over an in-cluster service credential. When the aggregate source is unconfigured or unreachable, the board SHALL show an honest degraded notice and everything else on the board SHALL keep working; the facet surface SHALL never write usage data.

#### Scenario: usage appears on the curation board

- **WHEN** an admin opens the curation board and the usage aggregate is reachable
- **THEN** each pack shows its weekly-active and round counts

#### Scenario: usage degrades honestly

- **WHEN** the usage aggregate is unreachable
- **THEN** the curation board shows a degraded notice in place of usage numbers and curation controls keep working
