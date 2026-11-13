## MODIFIED Requirements

### Requirement: Read-only connection status aggregation endpoint

The platform SHALL expose `GET /api/connections` returning, for the current user, a projection of every connection the connections section renders. Each entry SHALL carry a stable connection id, a display name, a state of `connected` / `stale` / `disconnected` / `not-configured`, and a short human-readable state reason where the underlying credential module provides one. The id set SHALL be `registry`, `facet-market`, `connector`, `line-wire-customer`, `line-lex`, `ciyuan-account`（display name 萬星·词元; replaces the retired `line-wanxing-caller`）, `paper-trading`, `search`. The response MUST NOT contain credential material of any form — no tokens, keys, JWTs, or secrets, in any field or nesting. Entries SHALL be per-user: one user's response SHALL NOT reflect another user's connections, and with auth off the projection SHALL describe the machine-owner identity. The search entry SHALL additionally report whether a user search key is set, and for admins the shared pool's health summary.

The `connector` entry SHALL additionally carry a **binding projection** so downstream surfaces (settings card, app badges, chat guidance) can render per-requirement state without a second call: the applied packs that declare connector bindings, and per binding its key, provider, operation class, state (`satisfied` / `missing` / `stale` / `unwired` / `undetermined`; `deprecated` rows are omitted because they are history, not requirements), and whether it is optional; plus aggregate counts (bindings total, unresolved, unwired). The projection MUST NOT carry binding tokens, PAT ids, connection credentials, or connection ids of providers the user has not authorized.

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

#### Scenario: connector entry carries binding projection

- **WHEN** the user has applied a pack that declares connector bindings
- **THEN** the `connector` entry lists each binding with its state and optional flag, plus unresolved and unwired counts

#### Scenario: binding projection leaks nothing

- **WHEN** the binding projection is inspected
- **THEN** it contains no binding token, no PAT id, and no connection id for providers the user has not authorized

#### Scenario: 无绑定用户投影为空集

- **WHEN** 用户未应用任何声明连接器绑定的包
- **THEN** `connector` 条目的绑定投影为空列表、计数为零，且不报错
