# connection-center Specification

## Purpose

设置「连接」分节：把散落在「技能与工具 → 商店」tab 与「网络搜索」分节里的用户级凭据连接与搜索接线收拢为唯一管理面，配可折叠品牌速查，并提供只读的连接状态聚合端点，供应用中心徽章（L1b）与对话内连接引导（L3）等下游消费。本能力只挪容器与聚合投影，不改变任何凭据模块的存储、铸造、注入与失效处理。

## ADDED Requirements

### Requirement: Connections section is the single home for user-level connections

The Settings modal SHALL provide a `connections` section (route `/settings/connections`), placed first in the Capabilities group. It SHALL host, as connect cards, every user-level credential surface that previously rendered inside the Tools & Skills market tab, plus the search wiring that previously rendered in the Network search section:

- **谦面**（grouped brand card）: 工具市场登录（registry JWT）and 市场设备配对（facet-market device pairing）as two rows under one card
- **萬星·连接器**: connector PAT accounts with slot list and active switching
- **产品线操作**: wire and lex ID-token mints
- **柏讯·模拟交易**: paper-trading token
- **搜索服务**: the user's own search key zone, plus the deployment shared-search wiring zone (relay configuration and pool health), the latter admin-only

Each card SHALL carry a one-sentence role subtitle stating what connecting it enables. The connect, disconnect, reconnect, and account-switch flows of each card SHALL behave unchanged from before the move — this is a container change only; credential storage, minting, profile injection, and 401-stale handling are not altered by this capability.

#### Scenario: the section renders all connect cards

- **WHEN** a signed-in user opens `/settings/connections`
- **THEN** the grouped 谦面 card, the connector card, the product-line card, the paper-trading card, and the search-service card all render, each with its role subtitle

#### Scenario: connect flows work unchanged from the new home

- **WHEN** the user triggers any connect flow from the connections section (e.g. the registry silent-SSO popup, a connector cross-mint, a line re-mint)
- **THEN** the flow completes exactly as it did when the card lived in the market tab, and the resulting credential serves the same MCP services as before

#### Scenario: admin-only wiring stays admin-only

- **WHEN** a non-admin user opens the search-service card
- **THEN** the shared-search wiring zone is not rendered
- **AND** the user's own search key zone remains available

### Requirement: Brand quick-reference in the connections section

The section SHALL present a collapsible brand quick-reference listing each ecosystem brand（萬星·词元、谦面、萬星·连接器、柏讯、识律）with a one-line description of what it is. It SHALL be collapsed by default and expandable in place; it SHALL NOT be a separate page or navigation target.

#### Scenario: quick reference collapses by default and expands in place

- **WHEN** the user opens the connections section
- **THEN** the quick-reference renders collapsed
- **AND** activating it expands the one-line-per-brand list inline without navigation

### Requirement: Connection panels are deep-linkable

Each connect card SHALL be addressable via a `panel` query parameter on `/settings/connections`（e.g. `/settings/connections?panel=registry`, `?panel=search`, `?panel=line-wire`), so install gates, mint round-trips, and downstream surfaces can link directly to a specific card. An unrecognized or absent `panel` value SHALL render the section normally without error.

#### Scenario: panel deep link scrolls to and highlights the card

- **WHEN** a user opens `/settings/connections?panel=registry`
- **THEN** the connections section renders with the registry connect card prominent (scrolled into view or visually highlighted)

#### Scenario: unknown panel degrades gracefully

- **WHEN** a user opens `/settings/connections?panel=nonsense`
- **THEN** the section renders normally with no card singled out and no error state

### Requirement: Read-only connection status aggregation endpoint

The platform SHALL expose `GET /api/connections` returning, for the current user, a projection of every connection the connections section renders. Each entry SHALL carry a stable connection id, a display name, a state of `connected` / `stale` / `disconnected` / `not-configured`, and a short human-readable state reason where the underlying credential module provides one. The response MUST NOT contain credential material of any form — no tokens, keys, JWTs, or secrets, in any field or nesting. Entries SHALL be per-user: one user's response SHALL NOT reflect another user's connections, and with auth off the projection SHALL describe the machine-owner identity. The search entry SHALL additionally report whether a user search key is set, and for admins the shared pool's health summary.

#### Scenario: aggregation returns states for every connection

- **WHEN** a signed-in user requests `GET /api/connections`
- **THEN** the response contains one entry per connect card with its state, and nothing else

#### Scenario: no credential material in the payload

- **WHEN** the aggregation response is inspected for any connected entry
- **THEN** no field at any nesting level contains a token, key, or credential value — states only

#### Scenario: per-user isolation

- **WHEN** user A has connected the connector and user B has not
- **THEN** user B's aggregation response reports the connector as disconnected, with no trace of user A's accounts

#### Scenario: stale credentials surface as stale

- **WHEN** a user's registry JWT has expired or a connector PAT was revoked upstream
- **THEN** the corresponding entry reports `stale` with the module's reason
