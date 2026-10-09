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

### Requirement: One identity provider, two arrival channels

The facet service SHALL authenticate direct visitors via OIDC authorization-code flow against the same identity tenant 壹座 uses — same users, same organizations, same creator groups — issuing its own session cookie scoped to the facet domain; and SHALL accept proxy-forwarded verified identity from 壹座 as the second channel. A user SHALL be one identity across both channels: publishing, subscriptions, and deployment ownership are recorded under one key regardless of arrival surface.

#### Scenario: Same user publishes from either surface

- **WHEN** a creator publishes a pack on the facet domain and later subscribes to another pack through 壹座's embedded surface (or vice versa)
- **THEN** both actions are recorded against the same identity, and creator gating applies identically on both surfaces

#### Scenario: Silent sign-in on the facet domain

- **WHEN** an already-authenticated 壹座 user initiates login on the facet domain
- **THEN** the OIDC flow completes via the shared tenant without a credential prompt

### Requirement: The serving plane reads deployments from the facet service

The facet service SHALL expose an internal read-only deployments API for the serving plane (萬星 facade): listing all deployments, resolving a pack's author identity, and listing a pack's deployment rows. The API SHALL be authenticated by an internal shared credential and SHALL NOT be reachable through the public surface without it. The facade SHALL resolve deployed agents through this API rather than any process-local access to the marketplace store.

#### Scenario: Facade resolves an agent after the marketplace moved out

- **WHEN** the facade resolves an agent slug, lists deployments, or checks a pack's author
- **THEN** it does so via the facet service's internal deployments API and behaves exactly as before the marketplace moved out

#### Scenario: Internal API refuses public access

- **WHEN** the deployments API is called without the internal credential
- **THEN** the call is refused and no deployment data is returned

### Requirement: MCP catalog cards on the facet surface

The facet surface SHALL present the registry's MCP servers as cards — name, description, connection endpoint reference, required group when present — aggregated read-only from the registry (openspec: registry-market-deployment), honoring the same visibility gating the registry enforces for the viewing identity. The facet surface SHALL NOT modify registry entries; the registry's software, domain, and deployment location are unchanged (ADR-0015).

#### Scenario: Visible MCP servers appear as cards

- **WHEN** a visitor opens the facet surface's MCP section
- **THEN** registry MCP servers visible to that identity are listed as cards with their endpoint reference

#### Scenario: Cards are read-only

- **WHEN** the facet surface is used by any identity
- **THEN** no registry entry is created, modified, or deleted through it

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
