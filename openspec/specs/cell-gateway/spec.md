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

#### Scenario: first visit cold-starts the user's cell

- **WHEN** an authenticated user with no running cell makes a request
- **THEN** the gateway starts their cell and serves the request once the cell is ready

#### Scenario: scheduled jobs block reaping

- **WHEN** idle reaping is enabled and a cell has at least one enabled cron job or bot
- **THEN** the gateway leaves that cell running despite idleness

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
