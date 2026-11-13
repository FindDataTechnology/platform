## MODIFIED Requirements

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

## ADDED Requirements

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
