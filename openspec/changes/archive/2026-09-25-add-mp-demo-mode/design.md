# Design: add-mp-demo-mode

## Context

The MP identity path today is strictly account-binding (`gateway/mp-auth.js`,
`gateway/mp-bindings.js`): an unbound openid gets `404 binding_required` and
the client auto-navigates to the bind-code page — the exact pattern WeChat's
rejection names. The gateway maps email → cell one-to-one via
`userIdFor(email)` (sha256 prefix) under `cell-data/`; cells are resident by
default (`CELL_IDLE_REAP_SECS=0`) and the protocol broadcasts every event to
all sockets of one cell. Identity reaches the cell through
`x-forwarded-email` / `x-forwarded-groups` headers sealed by
`CELL_GATEWAY_SECRET`. fd-prod is the 4GB PROD node with a known OOM hazard;
its LLM route is a free-tier model (no dollar exposure, but rate limits are
shared with real users). See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- A reviewer with a fresh WeChat account opens the mini program and chats —
  zero popups, zero login pages.
- Bounded worst case on the 4GB node: capped concurrent demo cells, short
  idle reaping, data deleted on reap.
- Self-hosted deployments bit-for-bit unchanged (flag off).
- The fix survives even if demo mode is off: no auto-navigation to sign-in
  anywhere.

**Non-Goals:**

- Migrating demo conversations into the account on upgrade (discarded).
- Separate LLM routing for demo cells (they use the deployment's model; the
  message cap bounds usage — revisit only if free-tier exhaustion shows up).
- Any new identity field (no phone number, no profile scope) anywhere.

## Decisions

### D1 — Demo identity: derived email + demo group, minted in the shared mp-auth module

`login()` gains a fallback behind `MP_DEMO_MODE`: no binding → mint
`{ sub: openid, email: "demo-" + sha256(openid).slice(0,8) + "@demo.invalid",
groups: ["demo"] }`. Deterministic derivation keeps the reviewer on the same
dataset across launches; sha256 keeps the raw openid out of paths and logs;
`.invalid` is a reserved TLD so a demo email can never collide with a real
Logto account; `groups: ["demo"]` rides the existing header plumbing to the
cell with zero new identity surface. Living in `createMpAuth` means the
single-process server inherits the feature but stays inert without the flag.

Alternatives rejected: **shared demo cell** (one cell broadcasts events to
all its sockets — strangers would see each other's chats); **phone-number
linking** (the rejection names that authorization pattern; the platform has
no phone field to match against; the component is enterprise-only and paid).

### D2 — Tenancy: one demo cell per openid, via the existing email→cell mapping

Because the demo email is derived per openid, `registry.ensure(user)` already
isolates every demo user into their own `cell-data/<hash>/` — no new tenancy
machinery. Isolation of chats follows for free.

### D3 — Limits enforced inside the cell, keyed on the demo group

The gateway proxies WS as an opaque byte pipe; parsing frames there would
re-implement the WebSocket protocol. The cell already parses every protocol
message and already receives `x-forwarded-groups`. The cell's WS layer counts
`prompt` messages when the demo group is present; at the cap it answers with
the existing `error` channel (rendered inline by the store, ends the turn)
carrying the friendly limit text and the bind suggestion. Counting is
per-cell-lifetime (not per-token), matching the demo dataset's lifetime.

### D4 — Demo cell lifecycle: a separate branch of the reaper

Demo cells diverge from the account contract in exactly three ways, all
keyed off the demo marker: (1) a concurrency cap — `ensure()` for a demo user
when `runningDemoCells >= MP_DEMO_MAX_CELLS` (default 3) returns a
distinctive busy error the gateway renders as a friendly 503; (2) idle reap
after `MP_DEMO_IDLE_SECS` (default 900) regardless of the deployment-wide
reap setting and regardless of the cron/bot preservation rule (demo cells
have no crons or bots); (3) data directory deleted on stop. Account cells are
untouched by all three.

### D5 — Client: user-initiated sign-in everywhere; demo detected from the login response

The chat page stops auto-navigating on `LOGIN_REQUIRED_EVENT`: an unbound
non-demo user gets a browsable page with a "登录后开始使用" banner; tapping
send while unbound navigates to the sign-in page (user action). The login
page gains a "暂不登录" back link. The client learns "demo" from the login
response's email (`@demo.invalid` suffix) — no protocol addition — and shows
a demo notice with a voluntary "绑定账号解锁完整功能" entry to the same
login page.

### D6 — Numbers as env-tunable defaults

`MP_DEMO_MAX_CELLS=3`, `MP_DEMO_IDLE_SECS=900`, in-cell message cap 20
(defaults, env-tunable). Sizing driver: the 4GB node with resident account
cells; 3 concurrent demo cells bound the worst-case footprint to a small
multiple of one cell.

## Risks / Trade-offs

- [4GB node OOM when demo cells coexist with account cells] → concurrency
  cap + 15-min reap bound both footprint and duration; `/api/gateway/status`
  gains the demo-cell count for monitoring.
- [Free-tier LLM rate limits shared with real users; a demo flood starves
  real chats] → message cap (20) × cell cap (3) bounds demo demand; revisit
  separate demo model routing only if observed.
- [Reviewer waits on demo-cell cold start (up to ~60 s)] → the client already
  renders an initializing state; the demo notice frames it ("正在准备体验
  环境"). Acceptable for a first-and-only demo visit.
- [Flag off while demo cells are running] → demo cells exit on their own via
  the idle reap and their data dirs are deleted; no manual cleanup step.
- [Demo identity confusion in logs/support ("who is demo-3f9a…?")] → the
  derived email is intentionally opaque; support correlates via WeChat
  openid only through the login flow's own logs, never via storage paths.

## Migration Plan

Deploy gateway + cell + mini program together (the client treats demo tokens
as ordinary tokens; the old client against a demo-enabled gateway still works
— it never sees `binding_required`). Enable by setting `MP_DEMO_MODE=1` on a
GATEWAY-shaped deployment. Rollback: unset the flag — new unbound openids get
`binding_required` again; leftover demo cells reap themselves away.

**2026-09-24 correction (verified against the live GitOps repo):** fd-prod
currently runs the SINGLE-PROCESS shape (`fd-infra-deploy/all-services/prod/
platform.yaml`: one `deploy/platform` pod, entrypoint `scripts/start.js`,
512Mi limit, node liuliangjkiimypbdzxa at 3.9GiB hosting Jenkins), and
`craw.finddatatech.cloud/healthz` answers a Logto redirect, not gateway JSON.
Setting `MP_DEMO_MODE` there does nothing (server.js hard-disables demo — one
shared runtime would expose the owner's data to anonymous reviewers). Demo on
fd-prod therefore requires a gateway-shape migration first: entrypoint swap
to `gateway/index.js`, `CELL_GATEWAY_SECRET` + a `CELL_DATA_ROOT` volume, a
one-time copy of `/data` into the owner's cell root, AND node capacity for
per-user cells (the current node cannot fit cells + Jenkins; demo cap would
need to start at 1). That is an infra decision, not a config flip — until it
happens, the WeChat violation is addressed client-side alone (deferred login
ships independently of demo mode; a rejected-review retry can add static
demo content, see proposal non-goals).

## Open Questions

- Whether the busy reply when the demo pool is full should be a queued wait
  versus an immediate notice — immediate notice is implemented first; queuing
  can be added later without contract changes.
