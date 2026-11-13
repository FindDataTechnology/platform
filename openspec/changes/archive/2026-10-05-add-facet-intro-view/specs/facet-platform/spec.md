## REMOVED Requirements

### Requirement: The facet web shell carries a product intro band

**Reason**: The band was the 2026-10-05 `add-facet-intro-hero` stopgap, taken under the thin-shell philosophy ("no new view"). The user decision of 2026-10-05 (six-round grilling) supersedes that boundary: the facet domain gets a mechanism-first intro view as the default landing, and the band's positioning line and quick facts move into it wholesale — the band is retired so the two surfaces cannot drift.

**Migration**: The band's facts (browse/subscribe/publish, MCP service catalog, published CLI one-liner) and the locale-following line-page backlink move into "The facet web shell carries a product intro view". The CLI install fact stays single-sourced: the packs footnote keeps only the `facet help` pointer.

## ADDED Requirements

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

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its three views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), and `#/mcp` (MCP service catalog). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency.

#### Scenario: deep link and refresh

- **WHEN** a visitor opens `#/mcp` directly, or reloads while on `#/packs`
- **THEN** the matching view renders with its tab active

#### Scenario: tab and hash stay in sync

- **WHEN** a visitor switches to the packs market tab
- **THEN** the location hash becomes `#/packs` and a reload keeps that view

#### Scenario: unknown hash falls back

- **WHEN** the location hash is unknown or empty
- **THEN** the intro view renders as the landing

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

The shell footer SHALL render a "寻数产品线" ladder on all three views: one row per line carrying the line's two-character mark (壹座, 识律, 柏讯, 谦面, 萬星), the ladder number written as the Chinese numeral (一, 十, 百, 千, 万 — per the naming contract 壹=1, 识=10, 柏=100, 谦=1000, 萬=10000), and the contract Chinese line name, with the facet row marked 当前站点. Each row SHALL link to that line's official page, following the active locale (`/zh/products/<line>/` under zh, `/products/<line>/` otherwise). Under non-Chinese locales the line-name column SHALL use the English concept names (Base, Lex, Wire, Facet, Constellation) while the two-character marks keep their Chinese characters. The figure SHALL be plain text with no image assets.

#### Scenario: ladder on every view

- **WHEN** a visitor opens any of the three views
- **THEN** the footer renders the five rows 一 壹座, 十 识律, 百 柏讯, 千 谦面 (marked 当前站点), 万 萬星

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

The shell footer SHALL further carry: (a) the brand block — the two-character mark 谦面, the name 谦面 Facet, and the tagline AI 编辑器的功能集与工具分发市场; (b) a contact block labeled 联系 with the email `1253774197@qq.com` as a `mailto:` link and the phone `17753221425` as a `tel:` link; (c) an entries list — packs market, MCP service catalog, the official facet line page (locale-following, per the ladder rule), and the CLI `npx @finddatatechonology/facet help`; (d) the company mission sentence 寻数科技聚焦AI时代下的文本和数据处理的基础设施建设，致力于推动信息平权，最终促进社会公平。 authored in all five locales (the Chinese text verbatim; en/es/fr/ja translated), rendered as a full-width text line; and (e) a copyright line (© 2026 寻数（FindData）· 谦面 Facet) alongside both filing statements as text links — the ICP filing `粤ICP备2026118740号-1` to `https://beian.miit.gov.cn/` and the public-security filing `粤公网安备44030002016558号` to the public-security query platform (`https://beian.mps.gov.cn/`), with no badge image. The footer SHALL be static — no state beyond links.

#### Scenario: brand, contact, and entries present

- **WHEN** the footer renders on any view
- **THEN** it shows the brand block with the tagline, the contact block with the mailto and tel links, and the entries list

#### Scenario: mission sentence in every locale

- **WHEN** the footer renders under zh-CN, or under any other supported locale
- **THEN** the mission sentence renders per locale, with the Chinese text verbatim under zh-CN

#### Scenario: both filing statements are linked

- **WHEN** the footer renders
- **THEN** `粤ICP备2026118740号-1` links to the MIIT filing site and `粤公网安备44030002016558号` links to the public-security query platform

### Requirement: The shell header carries a locale switcher

The shell header SHALL expose a locale switcher over the five supported locales (en, zh-CN, es, fr, ja) labeled with each locale's endonym, reusing the app's existing locale storage so an explicit choice persists across visits; the active locale SHALL be visible in the control.

#### Scenario: switch persists

- **WHEN** a visitor switches the locale
- **THEN** the shell re-renders in that locale and a reload keeps it

#### Scenario: explicit choice beats browser detection

- **WHEN** a stored locale exists and the browser language differs
- **THEN** the stored locale is used