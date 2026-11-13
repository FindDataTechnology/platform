# Proposal: add-mp-demo-mode

## Why

WeChat rejected the mini-program release: opening the app force-navigates to the
sign-in page before any functionality can be browsed ("未浏览体验功能服务，即要求
授权登录" — the platform's named violation pattern). The reviewer — necessarily an
unbound openid with no way to obtain a bind code — hits a dead-end login wall, so
no functionality is experienceable at all. We want reviewers (and curious new
users) to genuinely chat, without opening anonymous LLM spending or weakening the
existing account-binding model for self-hosted deployments.

## What Changes

- **Demo auto-provisioning (gateway, flag-gated `MP_DEMO_MODE`, default off)**:
  an unbound openid on a demo-enabled deployment receives a demo-scoped platform
  token immediately — no bind code, no login page, no authorization popup. Demo
  identities are deterministically derived per openid (`demo-<hash>@demo.invalid`,
  groups `["demo"]`), so the violation class "forced login at entry" structurally
  disappears on hosted deployments.
- **Bounded demo cell lifecycle (gateway)**: demo openids get their own isolated
  cell (one per openid — the cell protocol broadcasts events to every socket in a
  cell, so a shared demo cell would leak chats between strangers). Demo cells
  carry a concurrency cap, an idle-reap timer, and data-directory deletion on
  reap; real-account cells keep the resident, persistent contract unchanged.
- **In-cell demo limits (cell)**: the demo group marker flows to the cell via the
  existing `x-forwarded-groups` header; a cell serving a demo user enforces a
  per-cell message cap with a friendly limit reply plus a "绑定账号解锁完整功能"
  upgrade entry, and the client shows a demo-mode notice.
- **Deferred client login (mini program, applies everywhere)**: entering the app
  never auto-navigates to the login page. Sign-in becomes user-initiated: an
  unbound (non-demo) user sees a browsable chat page with a "登录后开始使用"
  affordance; attempting to send while unbound navigates to sign-in. The login
  page gains a "暂不登录" back affordance. On demo-enabled deployments the login
  page remains reachable as the voluntary account-upgrade entry.

Non-goals: no phone-number/avatar/nickname collection (the rejection names that
authorization pattern — adding it would reproduce the violation); no changes to
the bind-code flow or token format for real accounts; no anonymous access on
self-hosted deployments (flag stays off; `binding_required` behavior unchanged).

## Capabilities

### New Capabilities

- `mp-demo-mode`: end-to-end demo experience for unbound WeChat openids — demo
  identity derivation and minting, demo cell lifecycle bounds (concurrency cap,
  idle reaping, data deletion), in-cell message limits and upgrade entry, the
  `MP_DEMO_MODE` opt-in contract.

### Modified Capabilities

- `miniprogram-auth`: the unbound-openid outcome changes when demo mode is on —
  `POST /api/mp/login` returns a demo-scoped token instead of
  `404 binding_required` (default-off deployments keep the current contract);
  the client's response to an unbound state changes from auto-navigating to the
  sign-in page to a user-initiated sign-in affordance.
- `cell-gateway`: demo cells are an exception to the always-on contract —
  capped concurrent instances, reaped after a short idle window, data directory
  deleted on reap.

## Impact

- `gateway/mp-auth.js`: demo token minting behind the flag (shared module — the
  single-process server inherits it but stays inert without the flag).
- `gateway/index.js` + `gateway/spawner.js`: demo-cell concurrency cap, per-demo
  idle reaping, demo data-root deletion; `mp-bindings.js` unchanged.
- `server.js` / cell WS layer: demo-group detection via `x-forwarded-groups`,
  prompt counting, limit reply.
- `miniapp/src/`: remove the `LOGIN_REQUIRED_EVENT` auto-navigation; unbound
  banner + send-guard; demo notice; login-page back affordance.
- Deployment: fd-prod sets `MP_DEMO_MODE=1`; the 4GB PROD node's OOM hazard is
  the sizing driver for the concurrency cap (suggested 3 concurrent demo cells,
  15-minute reap, 20-message cap — numbers to be confirmed in design).
