# facet-platform Delta

## ADDED Requirements

### Requirement: Shell views carry a complete state contract

Every facet-shell view that loads async data (`#/packs`, `#/mcp`, `#/mine`, `#/curate`) SHALL render three distinct states: a loading state (a structural skeleton matching the loaded layout, never a bare text line), an empty state (guidance toward the next action, not a blank region), and an error state (the failure named plus a retry affordance). The intro view (`#/`) keeps its fully static contract unchanged. Motion SHALL be limited to state feedback, list entrance (≤200ms), and affordance transitions (≤150ms), and `prefers-reduced-motion: reduce` SHALL disable displacement and entrance animations while keeping state color changes. User-visible copy in shell views SHALL render through i18n keys in all five locales (en, zh-CN, es, fr, ja) — no inline bilingual or hardcoded strings.

#### Scenario: skeleton replaces the bare loading line

- **WHEN** `#/mine` or `#/curate` data is in flight
- **THEN** a structural skeleton renders in place of the loaded content, with no bare "加载中… / Loading…" text anywhere

#### Scenario: error state offers retry

- **WHEN** the market or catalog API call fails on a shell view
- **THEN** the view names the failure and offers a retry affordance instead of staying blank or spinning

#### Scenario: reduced motion strips animation, keeps state

- **WHEN** the OS signals `prefers-reduced-motion: reduce` and a shell view renders
- **THEN** entrance and displacement animations are absent while skeleton/loading indicators still render

#### Scenario: no hardcoded copy in shell views

- **WHEN** the shell renders in any of the five locales
- **THEN** every user-visible string resolves from the locale files — no bilingual inline pairs or untranslated literals

### Requirement: The intro path figure renders as a true graphic

The intro view's install-path figure SHALL render as a structured graphic (nodes and directional connections), not ASCII text lines, while keeping every existing facet-platform constraint: fully static, no live data, copy from i18n keys in all five locales, facts verifiable at build time, and the CLI command single-sourced.

#### Scenario: paths read as a diagram

- **WHEN** the intro view renders
- **THEN** the creator→market→壹座 and market→CLI install paths appear as connected nodes with directional links, legible at mobile widths

#### Scenario: the graphic stays static and keyed

- **WHEN** the path figure renders under any locale or API outage
- **THEN** it renders identically with no loading state and all its labels resolve from locale keys
