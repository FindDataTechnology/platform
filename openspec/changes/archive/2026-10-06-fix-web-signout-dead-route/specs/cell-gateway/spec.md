## ADDED Requirements

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
