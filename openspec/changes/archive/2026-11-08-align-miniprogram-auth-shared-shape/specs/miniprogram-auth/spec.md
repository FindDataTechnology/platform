# miniprogram-auth 单进程身份端点的共享形状

## MODIFIED Requirements

### Requirement: The single-process server exposes the mini-program identity endpoints

A single-process deployment with `AUTH_MODE=logto` and the mini-program
credentials configured SHALL expose the same mini-program login/bind
endpoints as the gateway, with identical request/response contracts:
`GET /api/mp/bindcode` (minted from an authenticated browser session or
platform token), `POST /api/mp/login` and `POST /api/mp/login-bindcode`
(reachable WITHOUT any browser session — the mini program has none), and
`DELETE /api/mp/bind`. Those four are the identity path; they are not an
exhaustive list of what a single-process deployment may serve under
`/api/mp/` — additional endpoints there are governed by their own
capabilities. The login endpoints SHALL be exempt from the session-cookie
requirement while carrying their own authentication (the wx.login exchange /
bind code). Openid⇄account bindings SHALL persist in the deployment's data
directory (or its dev-mode fallback) across restarts, in the same file format
the gateway uses.

The login/bind LOGIC and the bind-code page SHALL come from shared modules
rather than per-host copies: both hosts SHALL resolve the same bind-code and
login implementations, and SHALL render the human-facing bind-code page from
one shared renderer, so copy changes cannot land on one deployment shape and
miss the other. Route REGISTRATION is per host and MAY differ in exactly one
respect: how unauthenticated traffic reaches the endpoint — the gateway
rejects inside the route (browser redirect or `401` for programmatic
callers), while the single-process server's Logto gate refuses before the
route runs. That difference SHALL NOT change any status code, response body,
or page a client sees.

#### Scenario: login endpoints answer without a browser session

- **WHEN** the mini program calls `/api/mp/login` or `/api/mp/login-bindcode` on a single-process deployment with no session cookie
- **THEN** the call is answered on its own merits (token issued, `binding_required`, or a validation error) — not rejected for a missing browser session

#### Scenario: bind-code minting still requires a signed-in web user

- **WHEN** an unauthenticated request asks `/api/mp/bindcode` for a code on a single-process deployment
- **THEN** the request is rejected (`401` for programmatic callers, login redirect for browsers) and no code is minted

#### Scenario: the bind-code page is one page on both deployment shapes

- **WHEN** a signed-in web session asks `/api/mp/bindcode` with `Accept: text/html`, on the gateway and on a single-process deployment
- **THEN** each response is the human-facing bind page bearing the account identity and a 6-digit code, rendered by the same shared renderer, differing only in the freshly minted digits

#### Scenario: an extra `/api/mp/` endpoint is not a contract violation

- **WHEN** a single-process deployment also serves an endpoint under `/api/mp/` beyond the four identity routes
- **THEN** that endpoint is evaluated against the capability that defines it, and its presence does not change the four identity routes' contracts
