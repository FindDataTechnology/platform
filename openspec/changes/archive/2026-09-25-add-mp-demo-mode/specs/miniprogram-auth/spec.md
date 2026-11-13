## MODIFIED Requirements

### Requirement: Bound openids log in silently; unbound ones are asked to sign in

For a client whose openid is bound, the silent path SHALL exchange a fresh
`wx.login` code (`POST /api/mp/login`) for a platform token carrying the
BOUND account identity — no credentials, no UI, no user interaction. For an
unbound openid the endpoint's answer depends on demo mode:

- Demo mode disabled (default): the endpoint SHALL respond
  `404 binding_required`.
- Demo mode enabled: the endpoint SHALL respond with a demo-scoped platform
  token (see the `mp-demo-mode` capability) — no sign-in required.

In both cases the client SHALL NOT auto-navigate to a sign-in page on launch.
Sign-in SHALL be user-initiated: an unbound (non-demo) user sees a browsable
chat page with a "登录后开始使用" affordance, and navigating to the sign-in
page happens only when the user taps that affordance or attempts to send a
prompt while unbound. The sign-in page SHALL offer an explicit way back
("暂不登录") so the flow is never a dead end. The WeChat appid and secret
SHALL be held server-side only; the session key never leaves the server.

#### Scenario: returning device

- **WHEN** a user whose openid is bound opens the mini program
- **THEN** a fresh wx.login code exchanges for a token with the bound account's identity, with no UI

#### Scenario: first-ever device

- **WHEN** an unbound openid exchanges its wx.login code on a deployment without demo mode
- **THEN** the response is `404 binding_required`, the chat page stays browsable with a sign-in affordance, and no automatic navigation to the sign-in page occurs

#### Scenario: first-ever device with demo mode

- **WHEN** an unbound openid exchanges its wx.login code on a demo-enabled deployment
- **THEN** the response carries a demo-scoped token and the user can chat without ever seeing a sign-in page

#### Scenario: unbound user tries to send without demo mode

- **WHEN** an unbound user on a non-demo deployment taps send on the browsable chat page
- **THEN** the client navigates to the sign-in page (user-initiated), which offers a way back to browsing

### Requirement: Token expiry renews silently; a dropped binding surfaces as sign-in

Platform tokens SHALL have a bounded lifetime. When a token expires, the
client SHALL re-run the silent exchange (no user interaction) and retry the
failed request once. If the binding was removed (logout elsewhere), the
silent exchange SHALL return `binding_required` — or, on a demo-enabled
deployment, a fresh demo-scoped token — and the client SHALL show the
sign-in affordance (or continue in demo mode) instead of surfacing a generic
connection error.

#### Scenario: expired token on a REST call

- **WHEN** a REST call returns the authentication-rejected status
- **THEN** the client silently re-authenticates via the bound openid and retries the original request once before surfacing any error

#### Scenario: binding dropped on a demo deployment

- **WHEN** a user whose binding was removed re-runs the silent exchange on a demo-enabled deployment
- **THEN** the exchange returns a demo-scoped token and the user continues in demo mode without an error state

### Requirement: Logout removes the binding

An authenticated logout request (`DELETE /api/mp/bind` with the platform
token) SHALL remove the openid⇄account binding server-side. After logout,
the next launch SHALL return to the sign-in-required state — or, on a
demo-enabled deployment, to demo mode via the silent demo token.

#### Scenario: logout on this device

- **WHEN** the user logs out from the mini program
- **THEN** the binding is removed and the next wx.login exchange reports `binding_required`, or resolves to demo mode on a demo-enabled deployment
