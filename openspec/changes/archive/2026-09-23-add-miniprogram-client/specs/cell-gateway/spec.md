## MODIFIED Requirements

### Requirement: The gateway authenticates users before any cell traffic

The hosted deployment SHALL front all cells with a gateway that authenticates
every request and WebSocket upgrade before routing. Browser traffic SHALL be
authenticated through the platform's Logto identity provider; mini-program
client traffic SHALL be authenticated through platform tokens issued by the
WeChat login exchange (see `miniprogram-auth`). Unauthenticated browser
navigation SHALL be redirected to login; unauthenticated API and WebSocket
requests — from any client — SHALL be rejected. The gateway SHALL NOT forward
unauthenticated traffic to any cell.

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
