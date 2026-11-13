## MODIFIED Requirements

### Requirement: The facet shell carries a docs view

The facet web shell SHALL serve a documentation view at `#/docs`, publicly reachable without a credential, whose first screen routes the visitor by intent instead of by product jargon: four reader entries (install an agent, publish an agent, connect an MCP service, navigate this site), each leading to the section that answers it. Behind those entries the view SHALL carry: (a) an install section leading with 壹座 (the first-citizen path: subscribe in the market, then install into the runtime via 壹座's own surface with MCP credentials already wired — no command line), followed by one page per editor target — Claude Code, Cursor, ZCode, Codex, and Gemini CLI — each carrying the install command at one-command level, the target's skills directory, the target's native MCP configuration file, and the deep guide for that target; (b) an MCP access section presenting both connection paths honestly — the universal caller-key path (mint a `wgk-` key in the registry console, verify and store it with the CLI's connect flow, then let install write each target's native MCP configuration) and the client-native OAuth discovery path (the registry refuses unauthenticated MCP requests with a `WWW-Authenticate` header pointing at the protected-resource metadata, and serves the RFC 9728 / RFC 8414 discovery documents) — stating that zero-paste completion depends on the client's own support, since dynamic client registration is not offered; the section SHALL also carry the free-quota / paid-tier / revocation essentials; (c) a creation quickstart: the creator-group prerequisite, the three authoring routes (in-editor draft, one-click conversion from a custom preset, and manifest publish from the creator console), the version discipline (published versions immutable; an optional per-version note), the subscribe-vs-install distinction, and the deep authoring guide; and (d) a site-navigation section stating, in the viewer's language, what each shell entry is for and which path to take for which goal.

Deep guides SHALL be reachable from this host without leaving the viewer's network path: the guide destination SHALL be served from a location reachable on the mainland network, and a public-repository copy MAY be offered as a secondary link, never as the only path. The view SHALL carry a persistent table of contents that reflects the section the reader is currently in, and a client-side search over the view's own copy. In-page navigation SHALL NOT introduce new hash routes.

The view SHALL be fully static — no market or catalog live data, no loading or empty states — and its copy SHALL come from i18n keys authored in all five locales (en source of truth; `scripts/check-locales.js` enforces parity). Command strings, package name, target directories, and native MCP configuration file paths SHALL be single-sourced from code constants, never re-typed into copy; a unit test SHALL assert the documentation facts table equals the CLI's own target table so the docs cannot drift from the shipped CLI. Facts SHALL be limited to what is verifiable — no counts of servers, tools, or skills (those live on the live `#/mcp` surface).

#### Scenario: docs render statically and anonymously

- **WHEN** an anonymous visitor opens `#/docs` directly
- **THEN** the reader entries and all sections render with no credential and no dependency on any live API

#### Scenario: the first screen routes by intent

- **WHEN** the docs view renders
- **THEN** four reader entries are visible before any section body, and activating one moves the reader to the section that answers it

#### Scenario: 壹座 leads the install section

- **WHEN** the install section renders
- **THEN** 壹座 is the first and default-selected path, and the five editor targets follow as switchable pages

#### Scenario: each target page carries verifiable essentials

- **WHEN** a visitor switches to an editor target's page
- **THEN** the install command, that target's skills directory, and its native MCP configuration file render, all taken from the single-sourced facts table

#### Scenario: both MCP paths are stated honestly

- **WHEN** the MCP access section renders
- **THEN** the caller-key path and the OAuth discovery path are both presented, and the OAuth path states that zero-paste completion depends on the client's support rather than promising it universally

#### Scenario: deep guides are reachable from this host

- **WHEN** a reader follows a target's deep guide or the authoring guide
- **THEN** the destination resolves without requiring a host outside the mainland network path, and no guide is reachable only through a public-repository URL

#### Scenario: the table of contents follows the reader

- **WHEN** the reader scrolls into the MCP access section
- **THEN** the table of contents marks that section as current

#### Scenario: docs facts cannot drift from the CLI

- **WHEN** the documentation facts table and the CLI's target table are compared
- **THEN** the target set, every skills directory, and every native MCP configuration path are equal

#### Scenario: docs carry no drifting counts

- **WHEN** the docs view renders
- **THEN** it names no server, tool, or skill counts, directing the visitor to the live `#/mcp` surface instead

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), `#/mcp` (MCP service catalog, carrying the per-server depth views and the skills catalog), `#/docs` (the documentation view), `#/studio` (the creation face, visible to signed-in users), and the identity-conditional author surfaces — `#/mine` (creator console, visible to signed-in users) and `#/curate` (curation board, visible to admins). The tab control and the hash SHALL stay in sync in both directions: switching a tab updates the hash, and loading or navigating to a hash renders the matching view with that entry active. An unknown or empty hash SHALL fall back to `#/`.

Shell entries SHALL be split by weight: the public tabs are the four browsing views, a signed-in viewer additionally gets the creation face as a tab, and the author-only and admin-only surfaces SHALL be reachable from the account control rather than occupying the primary tab row. Demoting an entry SHALL NOT remove its hash: `#/mine` and `#/curate` SHALL keep resolving for a viewer whose identity grants them, so existing deep links and bookmarks continue to work, and navigating to a conditional hash without the grant SHALL fall back to the intro landing (the data plane rejects the calls anyway).

A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell. The shell itself SHALL add no router dependency for its own views; where a borrowed view requires routing context, the shell SHALL supply a local route table scoped to that view, and every navigation affordance inside a borrowed view SHALL either resolve within that local table or be replaced by a real external link to 壹座 — a control whose destination does not exist on the host SHALL NOT be rendered as an active affordance. Depth views SHALL remain reachable within `#/mcp` without adding new top-level hashes.

#### Scenario: deep link and refresh

- **WHEN** a visitor opens `#/mcp` directly, or reloads while on `#/packs`
- **THEN** the matching view renders with its entry active

#### Scenario: tab and hash stay in sync

- **WHEN** a visitor switches to the packs market tab
- **THEN** the location hash becomes `#/packs` and a reload keeps that view

#### Scenario: unknown hash falls back

- **WHEN** the location hash is unknown or empty
- **THEN** the intro view renders as the landing

#### Scenario: borrowed view needs no routing context

- **WHEN** the packs market view mounts on the facet shell and public packs exist
- **THEN** pack cards render and the view is interactive (search, detail dialog)
- **AND** the shell's own views mount with no routing provider and no host-only navigation affordance renders in them

#### Scenario: conditional tabs follow identity

- **WHEN** an anonymous visitor, a signed-in creator, and an admin each load the shell
- **THEN** the anonymous visitor sees only the four public entries; the creator sees the same four plus the creation face, and reaches the creator console (`#/mine`) from the account control; the admin additionally reaches the curation board (`#/curate`) from the account control
- **AND** typing `#/mine` or `#/curate` directly still resolves for a viewer whose identity grants it

#### Scenario: the creation face navigates honestly

- **WHEN** a viewer inside `#/studio` activates the face's back control or a run-domain affordance
- **THEN** the back control returns to the packs market within the shell, and every cross-domain affordance opens 壹座 as a real external link
- **AND** no control inside the face is a no-op because its destination is absent on this host

#### Scenario: depth views stay inside the mcp hash

- **WHEN** a visitor opens a server's depth view or the skills catalog
- **THEN** the view renders within `#/mcp` (no new top-level hash is introduced), and a reload on `#/mcp` returns to the catalog

### Requirement: The facet surface carries a creator console

The facet web shell SHALL provide a creator console at `#/mine` for signed-in users in the creator group, reachable from the account control and from the creation face: it lists the packs the viewer authored (with version history), offers unpublish (the unlisted semantics of openspec: pack-marketplace), toggles pack visibility between public and private (openspec: pack-visibility), and offers a publish-from-manifest entry that submits a manifest to the same identity-gated publish endpoint the cell-assembled flow uses, surfacing validation errors verbatim. The console SHALL be the single author-management surface — a drafts-and-published model SHALL NOT be split across two primary navigation entries. The creator console's version history SHALL render through the same version-list presentation the public detail view uses (openspec: pack-marketplace, Browse, search, and inspect): one shared component serves both surfaces, its rows carrying version number, publish time, publisher, the version's note when present, and per-version manifest/skill links — the author surface and the public surface cannot drift. Cell-side surfaces — installed-packs management and cell-assembled drafts — SHALL remain 壹座-only; the facet install surface keeps its guided refusal.

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

### Requirement: Curation is a facet-admin surface

The facet web shell SHALL provide a curation board at `#/curate` for admins, reachable from the account control: it lists all packs (including unlisted and private) and lets the admin edit a pack's curation state — category, domain tags, featured flag — and read back the current state. The board SHALL NOT be limited to a fixed slice of the catalogue: every pack SHALL be reachable through paging or search, and the board SHALL name how many packs exist in total. Category SHALL be chosen from the declared vocabulary, not typed as a free-form identifier; the domain axis SHALL use the same vocabulary. A row's edits SHALL be committed in one action and one request, and an uncommitted change SHALL be visibly distinguishable from a committed one. Non-admins SHALL NOT reach the board; the curation write endpoint SHALL reject them. Curation SHALL be presentation-level only: it never changes pack visibility, content, or installability.

#### Scenario: admin curates from the board

- **WHEN** an admin sets a category and features a pack on the curation board
- **THEN** the market listing shows that pack under the category filter and in the featured rail, and the pack's detail carries the category

#### Scenario: the whole catalogue is reachable

- **WHEN** the market holds more packs than one page of the board
- **THEN** the admin reaches every pack through paging or search, and the board states the total count

#### Scenario: one row commits one change

- **WHEN** an admin changes a pack's category, its domain tags, and its featured flag before committing
- **THEN** the three edits are sent in one request and the board reads back the committed state

#### Scenario: category comes from the vocabulary

- **WHEN** an admin edits a pack's category
- **THEN** the available values come from the declared vocabulary, and no free-text identifier input is offered

#### Scenario: non-admin cannot curate

- **WHEN** a non-admin calls the curation endpoint directly
- **THEN** the request is rejected and no curation state changes

## ADDED Requirements

### Requirement: One container grid spends the viewport

The facet web shell SHALL lay every view on a single shared container grid so that no view wastes the viewport while a sibling fills it. Content views (intro, docs) SHALL fill the container with a two-part composition — navigational rail plus reading measure — rather than a narrow measure centered with unused margins on both sides, and their reading measure SHALL stay within a comfortable line length. Listing surfaces (packs market, curation board, creator console) SHALL use the project's existing responsive ladder so entries tile in multiple columns on wide viewports instead of one full-width column. The three-pane creation face SHALL spend the available width and SHALL NOT stack redundant chrome above its own toolbar. At narrow viewports every view SHALL collapse to a single column with no page-level horizontal scrolling.

#### Scenario: a wide viewport is tiled

- **WHEN** the packs market renders at a viewport of 1920px
- **THEN** pack entries appear in at least three columns, and no entry's text line spans the full container width

#### Scenario: content views fill the container

- **WHEN** the intro or the docs view renders at a viewport of 1920px
- **THEN** the content occupies the shared container with a rail beside the reading measure, rather than a narrow centered column with unused margins on both sides

#### Scenario: the creation face has one header

- **WHEN** a viewer opens `#/studio`
- **THEN** exactly one row of shell/face chrome appears above the three-pane work area, and the work area uses the remaining width

#### Scenario: narrow viewports stay usable

- **WHEN** any view renders at a viewport of 375px
- **THEN** content collapses to a single column and the page does not scroll horizontally

### Requirement: Navigation names modules by the viewer's task

The shell SHALL name each module by the task the viewer performs there, in the viewer's own locale, and SHALL NOT present an untranslated term or an internal architecture term as a user-facing label. Each concept SHALL carry exactly one name across the shell: the tab label, the view's own title, and every reference from the docs view SHALL agree. The canonical label set is: intro `介绍`, packs market `智能体市场`, MCP catalog `MCP 与技能`, docs `使用指南`, creation face `创作台`, creator console `我的发布`, curation board `内容运营`; the English source names are the same concepts in English, and the remaining target locales SHALL translate them rather than carry the English word. A label SHALL NOT be reused for two different concepts (the viewer's published packs and 壹座's installed agents SHALL NOT share a name).

#### Scenario: no latin-only or jargon labels in a translated locale

- **WHEN** the shell renders in zh-CN, es, fr, or ja
- **THEN** no entry label is an untranslated English product word and no label is an internal architecture term

#### Scenario: one concept keeps one name

- **WHEN** the docs view refers to the author surface or the creation face
- **THEN** it uses exactly the label the corresponding entry uses

#### Scenario: locales stay in parity

- **WHEN** the five locale bundles are compared for shell labels
- **THEN** every shell label key exists in all five, and no non-English bundle still carries the English source string (a word the target language uses identically is recorded as a cognate, not accepted silently)

#### Scenario: installed agents are not re-named

- **WHEN** the shell presents the viewer's authored packs
- **THEN** the label differs from the name 壹座 uses for the viewer's installed agents
