## MODIFIED Requirements

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its three views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), and `#/mcp` (MCP service catalog). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency. A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell without any routing-context ancestor; a host-side navigation affordance that only makes sense inside 壹座 SHALL be suppressible by the shell without altering the borrowed view's data behavior.

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

## ADDED Requirements

### Requirement: A view failure cannot blank the shell

The facet web shell SHALL contain view failures: when any view throws during render, the shell (site mark, tabs, header controls, footer) SHALL remain rendered and the main area SHALL show an inline error notice in place of the failed view. A failed view SHALL NOT unmount the shell or blank the page, and switching to another tab after a failure SHALL render that view normally.

#### Scenario: a view crash is contained

- **WHEN** the active view throws during render
- **THEN** the header, tabs, and footer stay visible and the main area shows an inline error notice

#### Scenario: tabs still work after a contained failure

- **WHEN** a view has failed and the visitor switches to another tab
- **THEN** the other view renders normally
