## MODIFIED Requirements

### Requirement: First sign-in redeems a bind code minted from the web session

The platform identity provider (Logto) offers no password grant (deprecated
in OAuth 2.1), so credentials never enter the mini program. Instead, an
authenticated WEB session SHALL mint a single-use 6-digit bind code
(`GET /api/mp/bindcode`, 5-minute validity, bound to the signed-in account)
on any deployment shape whose identity path is configured. The same code is
the payload of BOTH presentation forms: the numeric code for manual entry,
and a QR encoding of `<web-origin>/settings/wechat-app?bindcode=<code>` for
scanning (see `settings-surface`). The mini program's first sign-in SHALL
redeem that code together with a fresh `wx.login` code at
`POST /api/mp/login-bindcode`; the server — the gateway or a single-process
deployment — SHALL then bind the WeChat openid to the account (persisted
server-side, surviving restarts, in that deployment's own data store) and
issue a platform token carrying the ACCOUNT identity (email + groups). A
wrong, expired, or already-redeemed code SHALL be rejected with `401` and
SHALL NOT create a binding; a malformed code SHALL be rejected with `400`.

The login page SHALL offer scan-to-bind as the PRIMARY action
（【扫码绑定】, `wx.scanCode`）, with manual 6-digit entry as the visible
fallback. The scanner's payload SHALL be parsed to a bind code by accepting,
in order: a URL whose query carries `bindcode=<6 digits>`; a bare 6-digit
payload; a payload whose last path segment or fragment is 6 digits. A scan
result that yields no 6-digit code SHALL be reported as a clear message and
SHALL leave the login form unchanged — never a silent failure. Bind success
SHALL navigate the user back to the chat page automatically. The login
page's guidance copy SHALL name the web location in user terms — the site
URL with 设置 → 微信小程序 — and SHALL NOT surface bare API paths such as
`/api/mp/bindcode`.

#### Scenario: successful first sign-in

- **WHEN** the user redeems a valid bind code from their signed-in web session — by scanning the web Settings QR or by typing the digits
- **THEN** the server binds the openid to that account and returns a platform token whose identity is the account's email and groups

#### Scenario: scanning the web Settings QR

- **WHEN** the user taps 扫码绑定 and scans the web Settings QR carrying `?bindcode=482913`
- **THEN** the client redeems the parsed code via the existing `login-bindcode` exchange and the user is returned to the chat page signed in — with no digits typed

#### Scenario: an unscannable payload says so

- **WHEN** the scanner returns a payload that yields no 6-digit code (e.g. a plain URL without `bindcode`, or free text)
- **THEN** the login page shows a message naming the problem and the manual field stays usable
- **AND** no exchange request is sent

#### Scenario: wrong, expired, or reused code leaves nothing behind

- **WHEN** the user redeems an incorrect, expired, or already-redeemed bind code — scanned or typed
- **THEN** the endpoint responds `401` and the openid remains unbound

#### Scenario: binding survives a single-process restart

- **WHEN** an openid was bound on a single-process deployment and the server restarts
- **THEN** the binding is still resolvable and the next silent launch succeeds without a new bind code

### Requirement: Bound openids log in silently; unbound ones are asked to sign in

For a client whose openid is bound, the silent path SHALL exchange a fresh
`wx.login` code (`POST /api/mp/login`) for a platform token carrying the
BOUND account identity — no credentials, no UI, no user interaction. For an
unbound openid on a deployment without an accountless sandbox the endpoint
SHALL respond `404 binding_required`, and the client SHALL NOT auto-navigate
to a sign-in page — the chat page stays browsable with a user-initiated
sign-in affordance (see `mp-demo-sandbox` for the sandbox-first landing that
replaces the parked-unbound state where the sandbox is deployed).

The sign-in page SHALL offer an explicit way back ("暂不登录") so the flow is
never a dead end. The WeChat appid and secret SHALL be held server-side
only; the session key never leaves the server.

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
