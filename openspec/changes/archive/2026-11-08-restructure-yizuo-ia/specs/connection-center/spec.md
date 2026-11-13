## MODIFIED Requirements

### Requirement: Connections section is the single home for user-level connections

The Settings modal SHALL provide a `connections` section (route `/settings/connections`), placed first in the Capabilities group. It SHALL host, as connect cards, every user-level credential surface that previously rendered inside the Tools & Skills market tab, plus the search wiring that previously rendered in the Network search section, plus the ciyuan account binding introduced by `ciyuan-account`:

- **萬星·词元**（ciyuan account card）: zero-paste binding (ciyuan email + password → server-side mint), test / disconnect, and a secondary paste-`sk-` entry
- **谦面**（grouped brand card）: 工具市场登录（registry JWT）and 市场设备配对（facet-market device pairing）as two rows under one card
- **萬星·连接器**: connector PAT accounts with slot list and active switching
- **产品线操作**: wire and lex ID-token mints（the former 萬星 Caller row moves into the 萬星·词元 card）
- **柏讯·模拟交易**: paper-trading token
- **搜索服务**: the user's own search key zone, plus the deployment shared-search wiring zone (relay configuration and pool health), the latter admin-only

Each card SHALL carry a one-sentence role subtitle stating what connecting it enables. The connect, disconnect, reconnect, and account-switch flows of the pre-existing cards SHALL behave unchanged — credential storage, minting, profile injection, and 401-stale handling of those modules are not altered by this capability.

The connect cards SHALL render as a responsive **card grid** rather than a single vertical column: two columns when the viewport leaves room, one column below that width, never dropping a card. Each card SHALL keep, without being opened, its brand mark, its name, its one-sentence role subtitle and **its own connection status presentation** — the panels already render their state inline (and that inline state is the single place it is derived), so the grid SHALL NOT add a second, duplicated status element on top of it. A card whose state is not yet known SHALL keep rendering its own unknown/not-configured presentation rather than asserting a state the server did not report. Changing the layout SHALL NOT change any card's connect, disconnect, reconnect, or account-switch behaviour, nor which element carries its `data-testid`.

The **连接器绑定账本**（connector-bindings ledger: the binding-first view listing each declared binding as satisfied / missing / stale / unwired / unmapped / undetermined）SHALL remain FIRST in reading order, because it answers "which of my installed packs still need something" and precedes the account cards. In the grid the ledger SHALL span the full width above the card grid and SHALL precede every connect card in both DOM order and keyboard tab order; it SHALL NOT be reflowed into a grid cell alongside the cards.

#### Scenario: the section renders all connect cards

- **WHEN** a signed-in user opens `/settings/connections`
- **THEN** the 萬星·词元 card, the grouped 谦面 card, the connector card, the product-line card (wire + lex only), the paper-trading card, and the search-service card all render, each with its role subtitle

#### Scenario: connect flows work unchanged from the new home

- **WHEN** the user triggers any connect flow from the connections section (e.g. the registry silent-SSO popup, a connector cross-mint, a line re-mint)
- **THEN** the flow completes exactly as it did when the card lived in the market tab, and the resulting credential serves the same MCP services as before

#### Scenario: admin-only wiring stays admin-only

- **WHEN** a non-admin user opens the search-service card
- **THEN** the shared-search wiring zone is not rendered
- **AND** the user's own search key zone remains available

#### Scenario: cards render as a grid with visible status

- **WHEN** the section renders at the modal's width
- **THEN** the connect cards SHALL be laid out as a multi-column card grid, not one vertical column
- **AND** each card SHALL keep its brand mark, name, role subtitle, and its own inline connection state
- **WHEN** the viewport narrows
- **THEN** the grid SHALL collapse to a single column without dropping any card or any card's state

#### Scenario: the binding ledger precedes the cards

- **WHEN** the user has one or more applied packs declaring connector bindings, and opens the connections section
- **THEN** the 连接器绑定账本 SHALL render full-width above the card grid
- **AND** keyboard tab order SHALL reach the ledger's bindings before any connect card
- **AND** the ledger's per-binding states SHALL be the same satisfied / missing / stale / unwired / unmapped / undetermined set it reported before this change

### Requirement: Connection panels are deep-linkable

Each connect card SHALL be addressable via a `panel` query parameter on `/settings/connections`（e.g. `/settings/connections?panel=registry`, `?panel=search`, `?panel=line-wire-customer`, `?panel=ciyuan-account`), so install gates, mint round-trips, and downstream surfaces can link directly to a specific card. The retired value `line-wanxing-caller` SHALL be treated as an alias of `ciyuan-account`. An unrecognized or absent `panel` value SHALL render the section normally without error.

Addressing a card SHALL keep its full existing semantics under the card grid: the addressed card SHALL be scrolled into view, SHALL receive focus, and SHALL be visually highlighted, exactly as it was in the former single-column layout. The panel ids SHALL NOT change when the layout changes: every id listed above, including the retired `line-wanxing-caller` alias, SHALL keep resolving to the same card in the grid.

The panel interaction SHALL take precedence over an active search filter: when a `panel` value is present, the addressed card SHALL be rendered regardless of the current filter text, and SHALL still be scrolled into view, focused, and highlighted. The section SHALL NOT silently drop the query text to make that happen — the filter input SHALL keep its text, and the section SHALL surface the fact that a filter is hiding other cards with an explicit, one-action way to clear it.

Deep links issued from outside the modal SHALL keep working as a contract, not a layout detail: install gates, app-center 去连接 actions, and line mint round-trips SHALL keep pointing at `/settings/connections?panel=<id>` and SHALL resolve to the same card in the grid. The grid SHALL NOT introduce a second link scheme, a nested route, or a modal-internal address that external callers would have to learn.

#### Scenario: panel deep link scrolls to and highlights the card

- **WHEN** a user opens `/settings/connections?panel=registry`
- **THEN** the connections section renders with the registry connect card prominent (scrolled into view or visually highlighted)

#### Scenario: ciyuan account panel is addressable, legacy alias resolves

- **WHEN** a user opens `/settings/connections?panel=ciyuan-account` or `?panel=line-wanxing-caller`
- **THEN** the 萬星·词元 card is the one highlighted

#### Scenario: unknown panel degrades gracefully

- **WHEN** a user opens `/settings/connections?panel=nonsense`
- **THEN** the section renders normally with no card singled out and no error state

#### Scenario: anchors keep working in the grid

- **WHEN** a user opens `/settings/connections?panel=connector` with the cards laid out as a grid
- **THEN** the connector card SHALL be scrolled into view, focused, and highlighted
- **AND** no other card SHALL be highlighted
- **AND** the same holds for every existing panel id, including the `line-wanxing-caller` alias

#### Scenario: an addressed card wins over the active filter

- **WHEN** the user has typed a filter query that hides the 搜索服务 card, and then opens `/settings/connections?panel=search`
- **THEN** the search-service card SHALL render, be scrolled into view, receive focus, and be highlighted
- **AND** the filter input SHALL still contain the typed query
- **AND** the section SHALL offer a single explicit action that clears the filter and restores the unfiltered grid

#### Scenario: external deep links still land on their card

- **WHEN** an install gate, an app-center 去连接 action, or a line mint round-trip navigates to `/settings/connections?panel=<id>`
- **THEN** the Settings modal SHALL open on the connections section with that card addressed
- **AND** the caller SHALL require no change to the link it emits

## ADDED Requirements

### Requirement: Connections section is searchable and scannable

The connections section SHALL present its connect cards as a scannable card grid（multi-column at the modal's width, single column at narrow widths）and SHALL provide a client-side search/filter field above the grid that filters the cards by card name and by the card's one-sentence role subtitle, matched in the active locale. Filtering SHALL be client-side over the already-rendered card set; it SHALL NOT change any card's connection state, mount, or unmount a card's connect controls, and it SHALL NOT hide the 连接器绑定账本.

The filter SHALL never silently discard user input state. A card holding unsaved form state — a typed-but-unsubmitted secret, a pasted key, a selected-but-unconfirmed account — SHALL NOT be unmounted by filtering: **filtering hides, it never unmounts**, so a non-matching card leaves the visual flow without losing the state its panel owns. The mechanism is deliberate: no panel exposes an "has pending input" signal, so deriving one per panel would be a guess, while keeping the component mounted is exact by construction. The filter text SHALL remain untouched by any other interaction (a `panel` deep link included), and the user SHALL always be able to clear the filter explicitly by emptying the field.

With an empty query the grid SHALL render every card unchanged. A query that matches no filterable card SHALL render an explicit no-match line rather than an empty grid region.

#### Scenario: filtering down to one card

- **WHEN** the user types a query into the connections filter that matches only the 搜索服务 card's name or role subtitle in the active locale
- **THEN** the grid SHALL show that card and hide the other connect cards without unmounting any of them
- **AND** the 连接器绑定账本 SHALL remain rendered above the grid
- **AND** the retained card's connect controls SHALL be the same controls, with unchanged behaviour and `data-testid`

#### Scenario: clearing the filter restores the full grid

- **WHEN** the user activates the clear-filter control, or empties the filter field
- **THEN** every connect card SHALL render again in its original grid position and order
- **AND** no card's connection state SHALL change as a result of the filter having been applied and cleared

#### Scenario: an addressed card remains reachable while a filter is active

- **WHEN** a filter query is active and a `panel` deep link addresses a card the query does not match
- **THEN** that card SHALL be rendered, scrolled into view, focused, and highlighted
- **AND** the filter field SHALL keep the user's query
- **AND** the user SHALL be able to clear the filter in one action to see the full grid again

#### Scenario: a card holding pending input is never discarded by filtering

- **WHEN** the user has typed a secret or pasted a key into a card's form without submitting, and then types a filter query that does not match that card
- **THEN** that card SHALL remain rendered and marked as retained because it holds pending input
- **AND** the typed value SHALL NOT be cleared, unmounted away, or otherwise lost
- **AND** a query matching no card at all SHALL still render an explicit no-match line rather than an empty grid region
