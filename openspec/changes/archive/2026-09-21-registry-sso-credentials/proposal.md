# registry-sso-credentials

## Why

Every registry MCP endpoint (`law-bench`, `fd-*`) rejects unauthenticated calls, and today the only path is a manually minted 8-day JWT pasted into each install form — per user, per demo, with no refresh. The platform and the registry both authenticate against the same Logto, so the user's existing platform login can silently establish their registry identity and mint a personal credential. Without this, every vertical-pack demo carries a manual token step and hosted customers can never self-serve MCP.

## What Changes

- **"连接 MCP 市场" (connect) flow**: a one-time, one-click browser flow — popup to the registry login (silent SSO via the shared Logto session), mint a 168 h personal JWT via the registry's token API from the popup context, hand it to the platform backend via `postMessage`. No password is ever re-entered; the user sees at most one click.
- **Per-user server-side credential store**: new table `user_registry_credentials` keyed by user email (per-cell in cloud mode), storing token + expiry. Secrets stay server-side; the browser never persists the token.
- **Registry MCP installs stop asking for tokens**: `origin: "registry"` market entries install without a config form when the installing user has a live credential; the credential is stamped as a reference (not the secret) on the installed record.
- **Header injection at connection time**: effective-profile generation resolves registry-origin servers' `Authorization` header from the owner's stored credential, refreshing from the stored value at each profile application.
- **Expiry handling**: a registry MCP call failing 401 marks the credential stale; the Store surfaces a re-connect prompt (one click, silent SSO again). Installs and profiles treat a missing/stale credential as a first-class state.
- **Manual paste remains** as the auth-off (desktop/dev) fallback path and for bring-your-own tokens.

Non-goals: no changes to the registry itself (its mint API and CORS/SameSite are ops configuration); no platform-side OAuth token exchange (V2 Logto-token pass-through is recorded as a possible successor, out of scope); no change to skill-install auth (server-side service token already).

## Capabilities

### New Capabilities

- `registry-credentials`: the per-user registry credential lifecycle — connect (silent SSO mint), server-side storage, install-time stamping, connection-time injection, staleness/refresh semantics, and the manual fallback.

### Modified Capabilities

- `extension-marketplace`: registry-origin MCP install drops the user-filled token placeholder when a live credential exists; `requiresConfig` semantics for registry entries become "needs a connected credential" instead of "needs a token pasted".
- `mcp-integration`: effective MCP profile generation injects the owner's registry credential as the `Authorization` header for registry-origin servers, and skips (with warning) those whose owner lacks a live credential — extending the existing requiredGroups filtering.

## Impact

- **Server**: new credential store module + routes (`connect-status`, `credential receipt`, `disconnect`); `extension-store.js` install path for registry entries; `dsh-profile.js` header injection; DB migration for `user_registry_credentials`; 401 detection on MCP sessions.
- **Frontend**: Store "connect" button + state badge, popup flow, re-connect prompt; install form conditional for registry entries.
- **Deployment**: registry CORS allow-list for the platform origin + `SameSite=None` session cookie (ops, documented); fd-prod unchanged otherwise.
- **Desktop/auth-off**: unchanged behavior; manual paste remains.
