# cell-gateway Specification

## Purpose

Defines the hosted deployment's front door: a gateway that authenticates users, routes each session to that user's isolated cell, keeps WebSocket connections sticky to the owning cell, and manages cell lifecycle including the scheduled-job preservation rule during idle reaping.

## Requirements

### Requirement: The gateway authenticates users before any cell traffic

The hosted deployment SHALL front all cells with a gateway that authenticates every request and WebSocket upgrade before routing. Browser traffic SHALL be authenticated through the platform's Logto identity provider; mini-program client traffic SHALL be authenticated through platform tokens issued by the WeChat login exchange (see `miniprogram-auth`). Unauthenticated browser navigation SHALL be redirected to login; unauthenticated API and WebSocket requests — from any client — SHALL be rejected. The gateway SHALL NOT forward unauthenticated traffic to any cell.

#### Scenario: anonymous request never reaches a cell

- **WHEN** an unauthenticated request arrives at the hosted deployment
- **THEN** the gateway responds with a login redirect (browser navigation) or `401` (API/WebSocket, including mini-program clients) without contacting any cell

#### Scenario: authenticated session routes to the user's cell

- **WHEN** a request with a valid authenticated session for user A arrives
- **THEN** the gateway routes it to user A's cell (starting one if none is running)
- **AND** the cell receives the user's verified identity, never a client-supplied one

#### Scenario: mini-program token routes to the WeChat user's cell

- **WHEN** a request arrives carrying a valid platform token issued for a WeChat openid
- **THEN** the gateway routes it to that openid's stable cell (starting one if none is running) and injects the token-derived verified identity, exactly as for a Logto session

#### Scenario: identity headers from a mini-program client are not trusted

- **WHEN** a mini-program request supplies identity headers of its own alongside a valid token
- **THEN** the gateway strips the client-supplied headers and injects only the verified token-derived identity, mirroring the browser path

### Requirement: WebSocket connections are sticky to the owning cell

The gateway SHALL route a user's WebSocket traffic to that same user's cell for the lifetime of the connection, and SHALL route reconnects from the same authenticated user to the same cell while it exists. A WebSocket SHALL never be connected to another user's cell.

#### Scenario: long-lived socket stays on its cell

- **WHEN** user A's WebSocket is established and user A's cell is restarted
- **THEN** the socket is served by user A's (new) cell after its session state resumes, not by any other user's cell

#### Scenario: concurrent users never share a runtime

- **WHEN** users A and B hold active chat streams at the same time
- **THEN** each stream's events (text, tool calls, session list, completions) reach only that user's connections

### Requirement: Cells start on demand and are always-on by default

The gateway SHALL start a user's cell on that user's first authenticated traffic, using that user's dedicated data directory and agent home. By default a started cell SHALL remain running. When idle reaping is enabled, the gateway MAY stop a cell after a configurable idle period, EXCEPT a cell with enabled cron jobs or enabled bots SHALL NOT be reaped. The deployment SHALL document the offline contract: a reaped (stopped) user cell means that user's chat is briefly unavailable on next visit (cold start) and that user's scheduled jobs do not fire while stopped.

The gateway SHALL maintain at most one cell process per user at any time: concurrent first requests for the same user SHALL collapse onto a single spawn (the in-flight spawn is registered before the spawn begins, not after it returns), and a cell record SHALL never be replaced while its process is still alive — a replacement SHALL first terminate the recorded process. A cell process whose record was replaced SHALL NOT be left running unreachable.

#### Scenario: first visit cold-starts the user's cell
- **WHEN** an authenticated user with no running cell makes a request
- **THEN** the gateway starts their cell and serves the request once the cell is ready

#### Scenario: scheduled jobs block reaping
- **WHEN** idle reaping is enabled and a cell has at least one enabled cron job or bot
- **THEN** the gateway leaves that cell running despite idleness

#### Scenario: concurrent first requests spawn one cell
- **WHEN** two requests for the same user arrive while that user's cell is still starting
- **THEN** exactly one cell process is spawned and both requests are served by it

#### Scenario: replacing a record terminates the old process
- **WHEN** a cell is spawned for a user whose previous record still holds a live process
- **THEN** the previous process is terminated before or during the replacement, leaving at most one live process for that user

#### Scenario: no orphan process survives record removal
- **WHEN** a cell record is dropped or replaced (share-respawn path, idle stop, crash recovery)
- **THEN** no live process for that user remains without a record, and a subsequent ensure starts exactly one fresh cell

### Requirement: Identity headers are trusted only from the gateway

A cell running in hosted mode SHALL honor proxy-injected identity headers only when the connection originates from the configured gateway; identity headers arriving from any other source SHALL be rejected or stripped. The gateway-to-cell trust SHALL be restricted by network reachability or a shared secret configured at deployment.

#### Scenario: direct-to-cell spoof attempt fails

- **WHEN** a client bypasses the gateway and sends a request with identity headers directly to a cell in hosted mode
- **THEN** the cell does not treat those headers as an authenticated identity

### Requirement: Gateway health and routing are observable

The gateway SHALL expose its own health endpoint and SHALL report per-user cell status (running, starting, stopped) to authenticated administrative requests. A cell that fails to start or exits unexpectedly SHALL surface as an error to that user's traffic and in the administrative status, without affecting other users' cells.

#### Scenario: one user's cell failure does not affect others

- **WHEN** user A's cell crashes
- **THEN** user A sees an error or cold-start retry
- **AND** user B's cell and traffic are unaffected

### Requirement: Demo cells run under a bounded lifecycle distinct from account cells

Cells started for demo identities (see the `mp-demo-mode` capability) SHALL be
managed separately from account cells: the gateway SHALL cap how many demo
cells run concurrently, SHALL stop a demo cell after a short configurable idle
window even when general idle reaping is disabled, and SHALL delete a demo
cell's data directory when the cell is stopped. Account cells SHALL keep the
existing resident, persistent contract regardless of demo-cell activity.

#### Scenario: demo reaping is independent of the deployment-wide setting

- **WHEN** idle reaping is disabled for account cells and a demo cell exceeds the demo idle window
- **THEN** the demo cell is stopped and its data directory is deleted, while account cells remain running

#### Scenario: account cells are unaffected by demo cleanup

- **WHEN** a demo cell is reaped and deleted
- **THEN** every account cell keeps running with its data directory intact

### Requirement: The gateway shuts down gracefully on termination signals

On SIGTERM or SIGINT, the gateway SHALL stop its cells through the cell registry (the "no cell outlives the gateway" invariant), close its auxiliary registries (share-token store, and the pack registry when running in pack mode), and exit with code 0 — in that order of precedence, with cell shutdown never skipped. A failure in any auxiliary close SHALL be isolated (logged, non-fatal) rather than aborting the shutdown chain. The shutdown path SHALL be mode-safe: the pack registry's close SHALL be reached identically in pack mode and facet-proxy mode (a no-op or guarded call in the latter), and neither mode SHALL reference an undefined binding.

#### Scenario: Pack-mode gateway exits cleanly on SIGTERM

- **WHEN** a gateway running in pack-registry mode (no FACET_BASE_URL) receives SIGTERM with cells resident
- **THEN** it SHALL log the cell stop, stop its cells via the registry, close the share and pack registries, and exit 0 — with no unhandled rejection or ReferenceError

#### Scenario: A failing auxiliary close does not skip cell shutdown

- **WHEN** the share-registry or pack-registry close throws during shutdown
- **THEN** the error SHALL be logged and swallowed, and the cell registry shutdown SHALL still run to completion before exit

### Requirement: Gateway-spawned cells advertise auth paths that exist in the deployment

The gateway SHALL configure every spawned cell with auth entry and exit paths that resolve to routes the deployment actually serves, so identity-sensitive UI (login and sign-out actions) built from the cell's `GET /api/auth/me` never targets a dead route. In the hosted gateway topology — where the gateway is the sole Logto client and no edge oauth2-proxy exists — cells SHALL report the gateway's login initiator (`/auth/login`) and logout route (`/api/auth/logout`) rather than the forward-auth-era defaults. Sign-out through the reported route SHALL clear the gateway session cookie and, when end-session is enabled, terminate the Logto SSO session before returning the browser to the site root.

#### Scenario: cell reports the gateway's logout route

- **WHEN** an authenticated user's browser fetches `/api/auth/me` through the gateway in the hosted topology
- **THEN** the response's `logoutUrl` names the gateway's logout route (`/api/auth/logout`), not the `/oauth2/sign_out` default

#### Scenario: sign-out clears the session and ends the SSO session

- **WHEN** the user activates the sign-out action built from that `logoutUrl`
- **THEN** the gateway clears its session cookie and redirects to the identity provider's end-session endpoint with its client id and a registered post-sign-out redirect, and the browser returns to the site root with no usable session

#### Scenario: self-hosted forward-auth deployments keep their defaults

- **WHEN** a single-process deployment runs behind a forward-auth edge (oauth2-proxy) with no gateway
- **THEN** the default `AUTH_LOGIN_PATH`/`AUTH_LOGOUT_PATH` values (`/oauth2/start`, `/oauth2/sign_out`) still apply and are served by that edge
