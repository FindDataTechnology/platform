# facet-platform Specification

## Purpose
谦面（facet）独立服务的平台契约：功能集市场与注册处以独立部署的形态对外（ADR-0015），壹座深度嵌入但互不隶属，身份经同一 IdP 双通道到达，服务面经内部只读 API 取部署数据。

## Requirements

### Requirement: The facet service deploys independently

The facet service SHALL be a standalone deployable — own process, own data store, own public domain — whose availability does not depend on any 壹座 process: with 壹座 entirely down, the facet surface serves browsing, detail, skill downloads of public packs, and direct OIDC login. 壹座 SHALL mount its marketplace surface as a same-origin reverse proxy onto the facet service: requests arriving through the proxy carry a server-verified forwarded identity, which the facet service SHALL accept as authoritative only when the request also carries the configured internal proxy credential. Both 壹座 deployment topologies (single-process and multi-cell gateway) SHALL implement the proxy; the production single-process topology is the acceptance-tested one.

#### Scenario: Marketplace survives 壹座 being down

- **WHEN** every 壹座 process is stopped and a visitor opens the facet domain
- **THEN** browsing, detail, and skill download of public packs work, and direct OIDC login works

#### Scenario: 壹座 embedded marketplace is same-origin and unchanged

- **WHEN** a logged-in 壹座 user opens the marketplace surface through the proxy
- **THEN** the surface behaves as before with no cross-domain redirect or re-login, and the facet service resolves the user from the forwarded verified identity

#### Scenario: Forged forwarded identity is refused

- **WHEN** a request reaches the facet service on its public domain carrying a forwarded-identity header without the internal proxy credential
- **THEN** the header is ignored and the request is treated as anonymous

### Requirement: The serving plane reads deployments from the facet service

The facet service SHALL expose an internal read-only deployments API for the serving plane (萬星 facade): listing all deployments, resolving a pack's author identity, and listing a pack's deployment rows. The API SHALL be authenticated by an internal shared credential and SHALL NOT be reachable through the public surface without it. The facade SHALL resolve deployed agents through this API rather than any process-local access to the marketplace store.

#### Scenario: Facade resolves an agent after the marketplace moved out

- **WHEN** the facade resolves an agent slug, lists deployments, or checks a pack's author
- **THEN** it does so via the facet service's internal deployments API and behaves exactly as before the marketplace moved out

#### Scenario: Internal API refuses public access

- **WHEN** the deployments API is called without the internal credential
- **THEN** the call is refused and no deployment data is returned

### Requirement: MCP catalog cards on the facet surface

The facet surface SHALL present the registry's MCP servers as cards — name, description, connection endpoint reference, required group when present — aggregated read-only from the registry (openspec: registry-market-deployment), honoring the same visibility gating the registry enforces for the viewing identity. Each card SHALL open a per-server depth view carrying: the server's tool surface (each tool's name and description, as stored on the registry entry; a server whose tool snapshot is absent renders an explicit "not captured" note rather than an empty list), its provenance (license and provider organization when the registry entry carries them; an entry without them SHALL render an explicit "not declared" mark, never an invented value), its required group and hosting tier as declared, and its endpoint with the connection essentials. The depth data SHALL load on demand — the card list payload SHALL NOT carry the tool surface. The facet surface SHALL NOT modify registry entries; the registry's software, domain, and deployment location are unchanged (ADR-0015).

The facet surface SHALL additionally present a skills catalog: the registry's skills as a browsable listing — name, description, upstream source repository when declared, author when declared, tags — under the same visibility gating (public entries visible anonymously; group-gated entries visible to a viewer whose identity carries a matching group). The skills listing SHALL carry the provenance marks openspec: ecosystem-curation promises (upstream repository and license visible; ecosystem vs FindData-official distinguishable), and SHALL be read-only like the MCP surface.

#### Scenario: Visible MCP servers appear as cards

- **WHEN** a visitor opens the facet surface's MCP section
- **THEN** registry MCP servers visible to that identity are listed as cards with their endpoint reference

#### Scenario: Cards are read-only

- **WHEN** the facet surface is used by any identity
- **THEN** no registry entry is created, modified, or deleted through it

#### Scenario: The depth view carries the tool surface and provenance

- **WHEN** a visitor opens a server's depth view
- **THEN** every captured tool renders with its name and description, and the license, provider organization, required group, and endpoint render as declared on the registry entry

#### Scenario: Missing metadata renders honestly

- **WHEN** a server's registry entry has no license, no provider organization, or no captured tool snapshot
- **THEN** the depth view renders an explicit not-declared / not-captured mark for that field, never an empty area and never an invented value

#### Scenario: The tool surface is loaded on demand

- **WHEN** a visitor opens the MCP section without opening any depth view
- **THEN** the card list renders without the tool surfaces; opening a depth view loads that server's tools

#### Scenario: Skills render with provenance

- **WHEN** a visitor opens the skills catalog
- **THEN** each visible skill renders with its description, upstream repository and author when declared, and tags; ecosystem entries are distinguishable from FindData-official entries by their provenance mark

#### Scenario: Skills gating follows the viewer's identity

- **WHEN** an anonymous visitor and a viewer with a required group each open the skills catalog
- **THEN** public skills appear for both, and group-gated skills appear only for the viewer whose identity carries a matching group

#### Scenario: The skills surface is read-only

- **WHEN** the facet surface's skills catalog is used by any identity
- **THEN** no registry skill entry is created, modified, or deleted through it

### Requirement: Marketplace data migrates without identity breaks

Published packs, versions, and subscription records SHALL migrate from the 壹座-hosted marketplace store to the facet service's store with pack ids, version numbers, and identity keys unchanged. Installed snapshots in subscribers' cells SHALL keep working throughout the cutover, and skill-body URLs minted before cutover SHALL remain resolvable during a transition window (redirect or dual-serve).

#### Scenario: Installed packs survive cutover

- **WHEN** the marketplace moves to the facet service
- **THEN** subscribers' cells keep their installed packs working, and update badges appear as before once the embedded surface is repointed

#### Scenario: Old skill URLs keep resolving

- **WHEN** a skill-body URL minted before cutover is fetched during the transition window
- **THEN** it resolves (redirect or dual-serve) to the same content

### Requirement: The facet web shell carries a product intro view

The facet web shell SHALL serve a static, mechanism-first product intro view at the hash root `#/` as the default landing, replacing the retired intro band. The view SHALL describe the product's own mechanics, not a product-line tour: (a) a hero carrying the value line 千人千面 — AI 编辑器的功能集与工具分发市场, a subtitle stating that packs bundle skills, MCP references, and agent personas for browsing, subscribing, and publishing with a one-line install into Claude Code / Cursor, a fact row (anonymous browsing; publish and subscribe after login, on the same identity as 壹座), and CTAs into the packs market and the MCP catalog; (b) three feature cards — what a pack contains (skill sources, MCP references, agent personas, plus version, tags, and author; the detail view exposes every skill's full body and the version history), subscribe and install are two different acts (a subscription is recorded in the market, shared with the 壹座 Store), and version snapshots (an install takes a definite version; re-running `install` takes a new snapshot; the CLI writes no MCP configuration and holds no credentials); (c) a text path figure — creator --publish--> the market --subscribe--> 壹座 (one-click install into the conversation runtime, MCP credentials already wired) and the market --CLI install--> Claude Code / Cursor skill directories (skill snapshot on disk, MCP references printed); (d) a quick start carrying the published CLI form `npx @finddatatechonology/facet install <pack id or URL containing the id>` (Claude Code by default; `--target cursor` and `--project <dir>` optional); and (e) a backlink to the official site's facet line page.

The line-page backlink SHALL follow the active locale (`/zh/products/facet` under zh, `/products/facet` otherwise). Facts SHALL be limited to what is verifiable at build time — no counts. The install command SHALL stay single-sourced (the packs footnote carries only the `facet help` pointer, no duplicated install line). Copy SHALL come from i18n keys authored in all five locales (en is the source of truth; `scripts/check-locales.js` enforces key-set parity, so "fallback" is a safety net, not the authoring mode). The view SHALL be fully static — no market or catalog live data, no loading or empty states.

#### Scenario: first visit lands on the intro

- **WHEN** a visitor opens the facet domain without a hash
- **THEN** the mechanism-first intro renders as the landing with CTAs into the packs market and the MCP catalog, and no credential is required

#### Scenario: intro describes the product's own mechanics

- **WHEN** the intro view renders
- **THEN** its body names what a pack contains, distinguishes subscribing from installing, explains version snapshots, and draws the install paths as a text figure — rather than touring the five product lines

#### Scenario: CLI fact stays verifiable and single-sourced

- **WHEN** the intro view and the packs footnote both mention the CLI
- **THEN** the intro view carries the published package name and install form, and the footnote carries only the `facet help` pointer

#### Scenario: line-page backlink follows locale

- **WHEN** the active locale is zh-CN and the visitor follows the intro view's official-site link
- **THEN** it targets `/zh/products/facet`; under en (or fallback locales) it targets `/products/facet`

#### Scenario: intro stays static

- **WHEN** the packs market API or the MCP catalog API is unreachable or slow
- **THEN** the intro view renders identically, with no loading state and no dependency on any live API

### Requirement: The facet shell carries a docs view

The facet web shell SHALL serve a static documentation view at `#/docs`, publicly reachable without a credential, organized as three sections: (a) an install section leading with 壹座 (the first-citizen path: subscribe in the market, then install into the runtime via 壹座's own surface with MCP credentials already wired — no command line), followed by one page per editor target — Claude Code, Cursor, ZCode, Codex, and Gemini CLI — each carrying the install command at one-command level, the target's skills directory, the target's native MCP configuration file, and a link to the deep guide in the public repository; (b) an MCP access section presenting both connection paths honestly — the universal caller-key path (mint a `wgk-` key in the registry console, verify and store it with the CLI's connect flow, then let install write each target's native MCP configuration) and the client-native OAuth discovery path (the registry refuses unauthenticated MCP requests with a `WWW-Authenticate` header pointing at the protected-resource metadata, and serves the RFC 9728 / RFC 8414 discovery documents) — stating that zero-paste completion depends on the client's own support, since dynamic client registration is not offered; the section SHALL also carry the free-quota / paid-tier / revocation essentials; and (c) a creation quickstart: the creator-group prerequisite, the three authoring routes (in-editor draft, one-click conversion from a custom preset, and manifest publish from the creator console), the version discipline (published versions immutable; an optional per-version note), the subscribe-vs-install distinction, and a link to the deep authoring guide shipped in the public repository.

The view SHALL be fully static — no market or catalog live data, no loading or empty states — and its copy SHALL come from i18n keys authored in all five locales (en source of truth; `scripts/check-locales.js` enforces parity). Command strings, package name, target directories, and native MCP configuration file paths SHALL be single-sourced from code constants, never re-typed into copy; a unit test SHALL assert the documentation facts table equals the CLI's own target table so the docs cannot drift from the shipped CLI. Facts SHALL be limited to what is verifiable — no counts of servers, tools, or skills (those live on the live `#/mcp` surface).

#### Scenario: docs render statically and anonymously

- **WHEN** an anonymous visitor opens `#/docs` directly
- **THEN** the three sections render with no credential and no dependency on any live API

#### Scenario: 壹座 leads the install section

- **WHEN** the install section renders
- **THEN** 壹座 is the first and default-selected path, and the five editor targets follow as switchable pages

#### Scenario: each target page carries verifiable essentials

- **WHEN** a visitor switches to an editor target's page
- **THEN** the install command, that target's skills directory, and its native MCP configuration file render, all taken from the single-sourced facts table

#### Scenario: both MCP paths are stated honestly

- **WHEN** the MCP access section renders
- **THEN** the caller-key path and the OAuth discovery path are both presented, and the OAuth path states that zero-paste completion depends on the client's support rather than promising it universally

#### Scenario: docs facts cannot drift from the CLI

- **WHEN** the documentation facts table and the CLI's target table are compared
- **THEN** the target set, every skills directory, and every native MCP configuration path are equal

#### Scenario: docs carry no drifting counts

- **WHEN** the docs view renders
- **THEN** it names no server, tool, or skill counts, directing the visitor to the live `#/mcp` surface instead

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), `#/mcp` (MCP service catalog, carrying the per-server depth views and the skills catalog), and `#/docs` (the documentation view), plus identity-conditional views — `#/mine` (creator console, visible to signed-in users) and `#/curate` (curation board, visible to admins). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency. A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell without any routing-context ancestor; a host-side navigation affordance that only makes sense inside 壹座 SHALL be suppressible by the shell without altering the borrowed view's data behavior. A conditional view's tab SHALL appear only when the viewer's identity grants it; navigating to a conditional hash without the grant SHALL fall back to the intro landing (the data plane rejects the calls anyway). Depth views SHALL remain reachable within `#/mcp` without adding new top-level hashes.

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
- **THEN** the anonymous visitor sees only the four public tabs; the creator additionally sees the creator-console tab (`#/mine`); the admin additionally sees the curation tab (`#/curate`)

#### Scenario: depth views stay inside the mcp hash

- **WHEN** a visitor opens a server's depth view or the skills catalog
- **THEN** the view renders within `#/mcp` (no new top-level hash is introduced), and a reload on `#/mcp` returns to the catalog

### Requirement: A view failure cannot blank the shell

The facet web shell SHALL contain view failures: when any view throws during render, the shell (site mark, tabs, header controls, footer) SHALL remain rendered and the main area SHALL show an inline error notice in place of the failed view. A failed view SHALL NOT unmount the shell or blank the page, and switching to another tab after a failure SHALL render that view normally.

#### Scenario: a view crash is contained

- **WHEN** the active view throws during render
- **THEN** the header, tabs, and footer stay visible and the main area shows an inline error notice

#### Scenario: tabs still work after a contained failure

- **WHEN** a view has failed and the visitor switches to another tab
- **THEN** the other view renders normally

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

### Requirement: Site marks are text characters sized by placement

Every site mark in the shell SHALL be a text character block (a styled square rendered from text, no image asset): the header navigation SHALL use the line's single character (谦), and the footer brand block and the ladder rows SHALL use the line's two-character mark (谦面, 壹座, 识律, 柏讯, 萬星). The Chinese characters SHALL be preserved in every locale, and the shell SHALL add no SVG or raster mark asset.

#### Scenario: header uses the single character

- **WHEN** a visitor views the header on any view
- **THEN** the site mark renders as the single character 谦 beside the site name

#### Scenario: footer and ladder use two-character marks

- **WHEN** the footer brand block and the ladder rows render
- **THEN** each mark renders as the line's two-character mark (谦面 in the brand block; 壹座/识律/柏讯/谦面/萬星 in the ladder)

#### Scenario: marks carry no image asset

- **WHEN** the shell renders in any locale
- **THEN** the marks are text, with no image request and no mark asset added to the bundle

### Requirement: The shell footer carries the five-line ladder

The intro landing's footer SHALL render a "寻数产品线" ladder: one row per line carrying the line's two-character mark (壹座, 识律, 柏讯, 谦面, 萬星), the ladder number written as the Chinese numeral (一, 十, 百, 千, 万 — per the naming contract 壹=1, 识=10, 柏=100, 谦=1000, 萬=10000), and the contract Chinese line name, with the facet row marked 当前站点. Each row SHALL link to that line's official page, following the active locale (`/zh/products/<line>/` under zh, `/products/<line>/` otherwise). Under non-Chinese locales the line-name column SHALL use the English concept names (Base, Lex, Wire, Facet, Constellation) while the two-character marks keep their Chinese characters. The figure SHALL be plain text with no image assets. The ladder is an intro-landing element: the tool views (`#/packs`, `#/mcp`, `#/docs`, `#/mine`, `#/curate`) carry the filing-only footer (see: brand, contact, mission, and filing statements) and SHALL NOT render the ladder.

#### Scenario: ladder on every view

- **WHEN** a visitor opens any view other than the intro landing `#/`
- **THEN** the footer renders no ladder figure
- **AND** on the intro landing the footer renders the five rows 一 壹座, 十 识律, 百 柏讯, 千 谦面 (marked 当前站点), 万 萬星

#### Scenario: tool views carry no ladder

- **WHEN** a visitor opens `#/packs`, `#/mcp`, `#/docs`, `#/mine`, or `#/curate`
- **THEN** the footer shows only the filing line and no ladder figure

#### Scenario: rows link to the line pages

- **WHEN** a visitor follows a ladder row under zh-CN, or under en
- **THEN** it targets the line's official page under `/zh/products/<line>/` or `/products/<line>/` respectively

#### Scenario: naming contract taken verbatim

- **WHEN** the ladder renders a line
- **THEN** its Chinese numeral, contract line name, and character mark match the naming contract verbatim

#### Scenario: non-Chinese locales show English concept names

- **WHEN** the active locale is en, es, fr, or ja
- **THEN** the line-name column renders Base/Lex/Wire/Facet/Constellation and the marks keep their Chinese characters

### Requirement: The shell footer carries brand, contact, mission, and filing statements

The intro landing's footer SHALL carry: (a) the brand block — the two-character mark 谦面, the name 谦面 Facet, and the tagline AI 编辑器的功能集与工具分发市场; (b) a contact block labeled 联系 with the email `1253774197@qq.com` as a `mailto:` link and the phone `17753221425` as a `tel:` link; (c) an entries list — packs market, MCP service catalog, the official facet line page (locale-following, per the ladder rule), and the CLI `npx @finddatatechnology/facet help`; (d) the company mission sentence 寻数科技聚焦AI时代下的文本和数据处理的基础设施建设，致力于推动信息平权，最终促进社会公平。 authored in all five locales (the Chinese text verbatim; en/es/fr/ja translated), rendered as a full-width text line. The filing statements — a copyright line (© 2026 寻数（FindData）· 谦面 Facet) alongside the ICP filing `粤ICP备2026118740号-1` linking to `https://beian.miit.gov.cn/` and the public-security filing `粤公网安备44030002016558号` linking to the public-security query platform (`https://beian.mps.gov.cn/#/query/webSearch?code=44030002016558`), with no badge image — SHALL render on EVERY view: the full footer block on the intro landing, and a filing-only slim footer (the copyright and both filing links, nothing else) on the tool views (`#/packs`, `#/mcp`, `#/docs`, `#/mine`, `#/curate`). The footer SHALL be static — no state beyond links.

#### Scenario: brand, contact, and entries present

- **WHEN** the intro landing renders
- **THEN** the footer shows the brand block with the tagline, the contact block with the mailto and tel links, and the entries list

#### Scenario: mission sentence in every locale

- **WHEN** the footer renders under zh-CN, or under any other supported locale
- **THEN** the mission sentence renders per locale, with the Chinese text verbatim under zh-CN

#### Scenario: both filing statements are linked

- **WHEN** a visitor opens the intro landing or any tool view
- **THEN** `粤ICP备2026118740号-1` links to the MIIT filing site and `粤公网安备44030002016558号` links to the public-security query platform on that view

#### Scenario: the slim footer carries only the filing line

- **WHEN** a tool view renders its footer
- **THEN** it contains the copyright line and both filing links and no brand, contact, entries, ladder, or mission content

### Requirement: The shell header carries a locale switcher

The shell header SHALL expose a locale switcher over the five supported locales (en, zh-CN, es, fr, ja) labeled with each locale's endonym, reusing the app's existing locale storage so an explicit choice persists across visits; the active locale SHALL be visible in the control.

#### Scenario: switch persists

- **WHEN** a visitor switches the locale
- **THEN** the shell re-renders in that locale and a reload keeps it

#### Scenario: explicit choice beats browser detection

- **WHEN** a stored locale exists and the browser language differs
- **THEN** the stored locale is used

### Requirement: Client walkthroughs are verified against real environments

The five supported client targets SHALL each carry a walkthrough record in its deep guide (docs/ecosystem/) verified against a real environment: a real console-minted caller key through `connect`, a real `install --write-mcp` landing skills in the target's directory and the native MCP config in the target's shape (byte-verified), and a wire-level `initialize` probe succeeding with that key and endpoint. Guides SHALL state the honest boundaries discovered by the walkthrough — a pack's MCP references reflect its manifest (connectivity further requires the server healthy and visible to the key's groups), the CLI device flow requires an IdP-registered client (unregistered today: paste-key is the working path), and probes must carry both Accept types.

#### Scenario: A reader trusts the guide's path

- **WHEN** a reader follows a client guide's install and connect steps
- **THEN** the documented skill paths and MCP config shapes match what the CLI actually writes, because each was byte-verified in a recorded walkthrough

#### Scenario: Boundaries are stated, not hidden

- **WHEN** a pack's MCP reference points at a server that is disabled or invisible to the caller's groups
- **THEN** the guide explains the resulting 405/401 honestly instead of implying misconfiguration of the client

### Requirement: The facet CLI carries an honest update path

The CLI SHALL record each install locally (`installed.json` under the facet home: pack id, name, target, scope, project, version, time) and SHALL offer `facet update [packRef] [--target]`: with no argument every recorded install refreshes; with a pack reference only that pack. Each refresh SHALL fetch the pack's latest published version — an unchanged version reports `已最新` and changes nothing; a newer version rewrites the skill snapshot through the install write path (identical bytes to a fresh install) and reports `v旧 → v新`. A pack that no longer resolves (unpublished, private, gone) SHALL report honestly per pack without aborting the rest. Updating SHALL carry no subscription semantics — it is a snapshot re-fetch, exactly like install.

#### Scenario: A stale install refreshes with version reporting

- **WHEN** a recorded install sits at v2 and the pack's latest is v3, and the deployer runs `facet update`
- **THEN** the skills directory rewrites to v3's snapshot, the record moves to v3, and the output names the pack with `v2 → v3`

#### Scenario: Current installs are a no-op

- **WHEN** every recorded install already matches the latest published version
- **THEN** update reports `已最新` per pack and writes nothing

#### Scenario: A vanished pack never blocks the rest

- **WHEN** one recorded pack no longer resolves
- **THEN** that pack reports its failure honestly and the remaining installs still refresh

### Requirement: Client capabilities are stated as a verified matrix

The facet surface SHALL publish a client-capability matrix — per client: user-level and project-level skill installation, user-level and project-level MCP config writing, marketplace form availability, and the update path — with each cell traceable to either a code fact (what the CLI writes) or a recorded real-environment walkthrough (what the client honors), never invention. The matrix SHALL render in the docs view (derived from the same single-source facts as the command tables, so drift fails tests) and ship in the OSS deep docs. A smoke script SHALL verify the CLI side periodically: isolated-home installs per target with the native config shapes asserted per client, runnable in CI without real credentials.

#### Scenario: The docs view answers "can it" at a glance

- **WHEN** a visitor opens the docs view's install section
- **THEN** the capability matrix renders one row per client with its verified cells, and the deep guides carry the per-client evidence

#### Scenario: The smoke catches a shape drift

- **WHEN** the CLI's write path for any target changes shape (file location or entry form)
- **THEN** the smoke script's assertion for that target fails, forcing the matrix and guides to move with the code

### Requirement: Self-hosted deploy surfaces degrade to official-market guidance

The pack deploy surface on any instance SHALL probe the instance's serving capability before offering deployment: when agent serving is not configured (the self-hosted shape), the surface SHALL render a guidance panel — the pack's agents belong on the official marketplace, with links to the marketplace and the creation guide, and an honest note that self-hosting the serving stack is possible — and SHALL NOT show the deploy form nor surface internal configuration errors. On an instance with serving configured, the deploy form renders exactly as before. A capability probe endpoint SHALL answer the question honestly both ways, and a deploy attempt that races the probe (the not-configured 503) SHALL land on the same guidance panel rather than a raw error.

#### Scenario: The self-hosted shape guides, never errors

- **WHEN** a visitor opens a serving pack's detail on an instance without agent serving
- **THEN** the deploy section renders the official-market guidance panel with marketplace and creation-guide links, no deploy form, and no internal environment names

#### Scenario: The official shape is unchanged

- **WHEN** the same pack detail opens on an instance with serving configured
- **THEN** the deploy form renders exactly as before the guidance existed

#### Scenario: The race lands on guidance too

- **WHEN** a deploy click slips through before the probe answers and the server refuses with its not-configured status
- **THEN** the panel appears in place of the raw error message

### Requirement: One identity provider, three arrival channels

The facet service SHALL authenticate direct visitors via OIDC authorization-code flow against the same identity tenant 壹座 uses — same users, same organizations, same creator groups — issuing its own session cookie scoped to the facet domain; SHALL accept proxy-forwarded verified identity from 壹座 as the second channel; and SHALL accept a paired device's verified app token (the device-pairing surface mounted on the facet service) as the third. A user SHALL be one identity across all channels: publishing, subscriptions, and deployment ownership are recorded under one key regardless of arrival surface.

#### Scenario: Same user publishes from either surface

- **WHEN** a creator publishes a pack on the facet domain and later subscribes to another pack through 壹座's embedded surface (or vice versa)
- **THEN** both actions are recorded against the same identity, and creator gating applies identically on both surfaces

#### Scenario: Silent sign-in on the facet domain

- **WHEN** an already-authenticated 壹座 user initiates login on the facet domain
- **THEN** the OIDC flow completes via the shared tenant without a credential prompt

#### Scenario: A paired device token publishes on the facet domain

- **WHEN** a CLI publishes through the facet domain with an app token whose account identity is in a creator group
- **THEN** the publish is recorded under that account identity and passes exactly the same creator gating, manifest validation, and rate limiting as a web-session publish

### Requirement: The self-host funnel carries a verified acceptance case card

The funnel's full journey — self-hosted publish, official listing via the CLI bridge, 万星 catalog deploy with a bound deployer billing key, a real external-caller turn settled in real money, and the deployer share landing in the earnings ledger — SHALL be verified end to end against production at least once per roadmap phase, and the record SHALL live as a case card under docs/ecosystem/ with per-hop evidence (commands, responses, ledger rows), the identity topology (author/deployer/caller and why caller≠deployer holds), and honest boundaries (the share is the deployer earnings ledger per ADR-0022 — there is no separate author ledger; earnings offset consumption, no withdrawal in v1).

#### Scenario: A self-hoster can trust the funnel story

- **WHEN** a self-hoster reads the case card and repeats its hops
- **THEN** each documented command and response matches production behavior, because every hop was recorded from a real run, not composed

#### Scenario: Boundaries are stated, not implied

- **WHEN** the case card reaches the earnings hop
- **THEN** it states plainly that the share accrues to the deployer (the pack author earns by deploying their own pack, or not at all in v1) and that earnings offset consumption rather than withdrawing
