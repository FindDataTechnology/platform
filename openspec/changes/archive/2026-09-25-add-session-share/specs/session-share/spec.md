## Purpose

Lets a user share one of their chat sessions as a read-only view that anyone with the token can open on the web (public URL) or in the mini-program (forward card), with owner-side revocation and abuse controls. The gateway brokers access; cells are unaware of sharing.

## ADDED Requirements

### Requirement: Authenticated users create share tokens for their sessions
A client with a verified gateway identity (web session or mini-program token) SHALL be able to create a share token for a specified session it can access. The token SHALL be at least 128 bits of randomness, SHALL NOT embed personally identifying information, and SHALL be stored in a gateway-level registry mapping token to owner identity, session id, creation time, revoked flag, and optional expiry.

#### Scenario: Owner creates a share
- **WHEN** an authenticated user requests a share for a session they own
- **THEN** the gateway SHALL create a registry row and return the token

#### Scenario: Cannot share another user's session
- **WHEN** a request names a session id that does not exist in the requesting user's cell
- **THEN** the gateway SHALL return an error and create no token

### Requirement: Public read-only view by token
`GET /api/share/:token` SHALL be accessible without authentication. For a valid, unexpired, unrevoked token it SHALL return the session title and its mirrored turns (role + content) read-only, resolving and if necessary starting the owner's cell to fetch them. Revoked, expired, or unknown tokens SHALL return a not-available response that does not reveal whether the session ever existed or who owned it.

#### Scenario: Anonymous recipient opens a valid share
- **WHEN** a browser or mini-program requests a valid token with no session of their own
- **THEN** the session title and mirrored turns SHALL be returned read-only

#### Scenario: Revoked token
- **WHEN** a token has been revoked and is requested
- **THEN** the endpoint SHALL return the not-available response with no session content

#### Scenario: Owner's account cell stopped
- **WHEN** the owner's account cell is stopped or reaped (its data root persists) and the token is requested
- **THEN** the gateway SHALL restart the owner's cell and serve the share normally

#### Scenario: Demo cell data is ephemeral
- **WHEN** the owner's demo cell has exited (its data root is cleaned by design, openspec: mp-demo-mode) and the token is requested
- **THEN** the endpoint SHALL return the not-available response, indistinguishable from a revoked token

### Requirement: Web public share page
The web app SHALL serve `/share/:token` without requiring login, rendering the shared session read-only (Markdown rendered, no input controls), with a clear indication that the content was shared by its owner. Invalid tokens SHALL render a friendly "no longer available" page.

#### Scenario: Logged-out browser opens a share URL
- **WHEN** an unauthenticated browser navigates to `/share/<valid-token>`
- **THEN** the read-only session view SHALL render without any login redirect

### Requirement: Mini-program share page and forward card
The mini-program SHALL provide a read-only shared-session page that loads by token from the public endpoint, and the share action SHALL produce a WeChat forward card (`useShareAppMessage`) whose path opens that page with the token. The page SHALL render invalid tokens as "no longer available".

#### Scenario: WeChat friend opens a forward card
- **WHEN** a recipient taps the forward card in a WeChat chat
- **THEN** the mini-program SHALL open the shared-session page populated with the shared turns, regardless of the recipient's own login state

### Requirement: Owner can list and revoke shares
An authenticated user SHALL be able to list their active share tokens (session id and creation time) and revoke any of them; revocation SHALL take effect for subsequent reads of the public endpoint immediately.

#### Scenario: Revoke cuts off access
- **WHEN** the owner revokes a token that a recipient had opened earlier
- **THEN** the next request for that token SHALL return the not-available response

### Requirement: Abuse controls on the public endpoint
The public share endpoint SHALL apply rate limiting per source and SHALL NOT expose cross-origin read access beyond what the web share page needs. Responses SHALL contain no security headers regression relative to other public gateway endpoints.

#### Scenario: Token enumeration attempt
- **WHEN** a client probes the endpoint with many invalid tokens
- **THEN** responses SHALL be rate-limited and indistinguishable for unknown vs revoked tokens
