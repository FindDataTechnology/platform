## ADDED Requirements

### Requirement: Composer textarea uses 16px font on mobile viewports to prevent iOS focus zoom

The composer textarea SHALL render at a font size of at least 16px on viewports below the `md` breakpoint. Desktop viewports (`md` and above) SHALL keep the established 14px (`text-sm`) composer typography. The page SHALL NOT disable browser zoom via `maximum-scale` to work around iOS focus auto-zoom — the font-size floor is the only permitted mechanism.

#### Scenario: mobile focus does not zoom the viewport

- **WHEN** the page renders at a mobile viewport (below `md`, e.g. 390px wide) in an iOS browser (Safari or WeChat built-in) and the user focuses the composer textarea
- **THEN** the browser SHALL NOT auto-zoom the page (computed textarea font-size is ≥16px)

#### Scenario: desktop typography is unchanged

- **WHEN** the page renders at or above the `md` breakpoint
- **THEN** the composer textarea font size SHALL remain 14px (`text-sm`)

#### Scenario: browser zoom stays user-controllable

- **WHEN** the viewport meta is inspected
- **THEN** it SHALL NOT set `maximum-scale=1` or `user-scalable=no`
