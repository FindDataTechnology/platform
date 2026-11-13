# connection-center Delta

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

### Requirement: Connection panels are deep-linkable

Each connect card SHALL be addressable via a `panel` query parameter on `/settings/connections`（e.g. `/settings/connections?panel=registry`, `?panel=search`, `?panel=line-wire-customer`, `?panel=ciyuan-account`), so install gates, mint round-trips, and downstream surfaces can link directly to a specific card. The retired value `line-wanxing-caller` SHALL be treated as an alias of `ciyuan-account`. An unrecognized or absent `panel` value SHALL render the section normally without error.

#### Scenario: panel deep link scrolls to and highlights the card

- **WHEN** a user opens `/settings/connections?panel=registry`
- **THEN** the connections section renders with the registry connect card prominent (scrolled into view or visually highlighted)

#### Scenario: ciyuan account panel is addressable, legacy alias resolves

- **WHEN** a user opens `/settings/connections?panel=ciyuan-account` or `?panel=line-wanxing-caller`
- **THEN** the 萬星·词元 card is the one highlighted

#### Scenario: unknown panel degrades gracefully

- **WHEN** a user opens `/settings/connections?panel=nonsense`
- **THEN** the section renders normally with no card singled out and no error state

### Requirement: Read-only connection status aggregation endpoint

The platform SHALL expose `GET /api/connections` returning, for the current user, a projection of every connection the connections section renders. Each entry SHALL carry a stable connection id, a display name, a state of `connected` / `stale` / `disconnected` / `not-configured`, and a short human-readable state reason where the underlying credential module provides one. The id set SHALL be `registry`, `facet-market`, `connector`, `line-wire-customer`, `line-lex`, `ciyuan-account`（display name 萬星·词元; replaces the retired `line-wanxing-caller`）, `paper-trading`, `search`. The response MUST NOT contain credential material of any form — no tokens, keys, JWTs, or secrets, in any field or nesting. Entries SHALL be per-user: one user's response SHALL NOT reflect another user's connections, and with auth off the projection SHALL describe the machine-owner identity. The search entry SHALL additionally report whether a user search key is set, and for admins the shared pool's health summary.

#### Scenario: aggregation returns states for every connection

- **WHEN** a signed-in user requests `GET /api/connections`
- **THEN** the response contains one entry per connect card with its state — including `ciyuan-account` and no `line-wanxing-caller` — and nothing else

#### Scenario: no credential material in the payload

- **WHEN** the aggregation response is inspected for any connected entry
- **THEN** no field at any nesting level contains a token, key, or credential value — states only

#### Scenario: per-user isolation

- **WHEN** user A has connected the connector and user B has not
- **THEN** user B's aggregation response reports the connector as disconnected, with no trace of user A's accounts

#### Scenario: stale credentials surface as stale

- **WHEN** a user's registry JWT has expired, a connector PAT was revoked upstream, or a ciyuan account probe returned 401
- **THEN** the corresponding entry reports `stale` with the module's reason
