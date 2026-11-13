# registry-credentials Specification (delta)

## Purpose

Stores one MCP-registry credential per user so that installing and running
registry-origin MCP servers needs no manual token handling: a silent SSO connect
mints the credential once, installs reference it instead of embedding a secret,
and the effective profile resolves the header at each application.

## ADDED Requirements

### Requirement: Silent SSO connect flow

The platform SHALL offer a per-user "connect MCP market" flow: a popup opens the registry's login URL; because the platform and registry share the Logto identity provider, an already-authenticated user SHALL complete the registry login without re-entering credentials (silent SSO). Within the popup context the flow SHALL mint a personal registry access token via the registry's token API and deliver it to the platform backend via a browser-mediated handoff; the token MUST NOT be persisted in browser storage. When the registry login cannot complete silently (no Logto session, expired), the popup SHALL surface the registry's normal login and the flow continues after it.

#### Scenario: happy path is one click

- **WHEN** a logged-in platform user clicks 连接 MCP 市场 and both CORS and the shared Logto session are in place
- **THEN** the popup completes registry login silently, mints a token, and closes without any credential entry by the user
- **AND** the platform reports the connection as live with the token's expiry

#### Scenario: no shared session falls back to visible login

- **WHEN** the user has no active Logto session with the registry
- **THEN** the popup shows the registry/Logto login, and the flow resumes the mint after successful login

#### Scenario: mint failure surfaces actionable state

- **WHEN** the registry rejects the mint (rate limit, auth error) or is unreachable
- **THEN** the platform reports connection failed with the reason, keeps any prior credential, and offers retry

### Requirement: Server-side per-user credential storage

The platform SHALL store at most one registry credential per user (keyed by email; per-cell in cloud mode): the token and its expiry, never in browser-persisted storage. The credential SHALL NOT be returned by any API in plaintext; APIs expose only presence and expiry. Deleting the credential (disconnect) SHALL remove the stored row.

#### Scenario: credential is write-only from the client's perspective

- **WHEN** any client queries connection status
- **THEN** the response contains connection state and expiry only, never the token

#### Scenario: disconnect removes state

- **WHEN** a connected user disconnects
- **THEN** the stored credential row is deleted and subsequent registry-origin profile generation omits those servers

### Requirement: Registry-origin installs use the stored credential

Installing a market MCP entry whose origin is the registry SHALL NOT prompt for a token when the installing user has a live stored credential: the installed record SHALL carry a reference to the registry credential (not the secret). When the user has no live credential, the install UI SHALL direct the user to connect first (or offer the manual-paste fallback). Manual token paste remains supported as a fallback for auth-off deployments and bring-your-own tokens, and a pasted token SHALL be stored the same way as a minted one.

#### Scenario: install with live credential has no token form

- **WHEN** a connected user installs a registry MCP entry
- **THEN** the setup form shows no fillable credential field and Add is enabled immediately
- **AND** the installed record references the registry credential rather than embedding a secret

#### Scenario: unconnected user is routed to connect

- **WHEN** a user without a live credential opens install on a registry entry
- **THEN** the UI offers 连接 MCP 市场 (and the manual paste fallback), and Add is disabled until a credential exists

### Requirement: Connection-time header injection

Effective-profile generation SHALL resolve the `Authorization` header for registry-origin MCP servers from the current user's stored credential at each profile application, so a refreshed credential takes effect without reinstalling servers. A registry-origin server whose owner lacks a live credential SHALL be omitted from the effective profile with a warning (mirroring requiredGroups semantics), not passed with a placeholder header.

#### Scenario: refreshed token flows without reinstall

- **WHEN** a user's credential is refreshed (re-connect) after expiry and the next profile application runs
- **THEN** registry-origin servers connect with the new token and no reinstall occurred

#### Scenario: missing credential omits server, keeps record

- **WHEN** a registry-origin server's owner has no live credential at profile application
- **THEN** the server is omitted from the effective profile with a warning
- **AND** the installed record is unchanged, so the server returns when a credential is stored again

### Requirement: Staleness detection and re-connect

A 401 from a registry MCP endpoint SHALL mark the user's credential stale and surface a re-connect prompt in the Store; the re-connect flow is the same silent-SSO connect. Until re-connected, the stale credential SHALL be treated as absent for profile generation.

#### Scenario: mid-session expiry prompts one-click recovery

- **WHEN** a registry MCP call returns 401 while the user is connected
- **THEN** the credential is marked stale, the Store shows a re-connect prompt, and one silent re-connect restores the servers on the next profile application
