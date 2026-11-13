## MODIFIED Requirements

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
