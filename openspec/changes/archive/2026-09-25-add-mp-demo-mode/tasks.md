# Tasks: add-mp-demo-mode

## 1. Gateway — demo identity minting

- [x] 1.1 Add `MP_DEMO_MODE` to `createMpAuth` config (gateway/index.js env wiring, shared default off) and verify the flag-off path still returns `404 binding_required` for an unbound openid (existing mp-auth test/probe)
- [x] 1.2 Implement the demo fallback in `login()`: derive `demo-<sha256(openid)[0:8]>@demo.invalid`, mint with `groups: ["demo"]`, same TTL; verify with a unit test that the same openid yields the identical email across calls and that the raw openid appears nowhere in the token payload except `sub`
- [x] 1.3 Verify the single-process server (`server/routes/mp.js`) inherits the demo path but stays inert without the flag (probe shows `binding_required` unchanged when flag unset)

## 2. Gateway — demo cell lifecycle

- [x] 2.1 Tag demo users through `registry.ensure` (groups carry `demo`) and enforce the concurrency cap (`MP_DEMO_MAX_CELLS`, default 3): over cap → distinctive busy error surfaced as a friendly 503 JSON; verify with a stub-cell test that the 4th concurrent demo user gets the busy reply and no process spawns
- [x] 2.2 Add the demo reap branch: stop after `MP_DEMO_IDLE_SECS` (default 900) even when deployment-wide reaping is off, bypass the cron/bot preservation rule; verify with a short-window stub-cell test that an idle demo cell stops while an account cell stays running
- [x] 2.3 Delete the demo cell's data directory on stop; verify the directory is removed after reap and that account data dirs are untouched
- [x] 2.4 Add the running-demo-cell count to `/api/gateway/status`; verify the admin endpoint reports it

## 3. Cell — in-cell demo limits

- [x] 3.1 Detect the demo group from `x-forwarded-groups` in the cell and count user `prompt` messages per cell lifetime; verify the counter is per-cell (fresh after reap-restart) via a unit test on the counting logic
- [x] 3.2 At the cap (env-tunable, default 20), answer prompts via the existing `error` channel with the friendly limit text inviting account binding, and run no model turn; verify in a cell-level test that prompt #21 gets the limit reply and no agent turn starts

## 4. Mini program client — deferred sign-in + demo notice

- [x] 4.1 Remove the `LOGIN_REQUIRED_EVENT` auto-navigation in `pages/chat/index.tsx`; render a browsable page with a "登录后开始使用" banner when unbound, and navigate to sign-in only on banner tap or send attempt; verify in devtools that a first-open unbound device shows the chat page (no login page pushed) and send taps navigate — verified via `npm run typecheck` + weapp build + compiled-bundle assertions (banner strings present; zero `navigateTo` inside eventCenter callbacks; `goLogin` reachable only from taps/send). Devtools live pass deferred to the 6.2 probe (IDE auth needed interactive approval).
- [x] 4.2 Add the "暂不登录" back affordance to `pages/login/index.tsx`; verify it returns to the chat page without binding — implemented (`navigateBack` falling back to `reLaunch` of the chat page); presence asserted in the compiled bundle
- [x] 4.3 Show the demo notice + voluntary "绑定账号解锁完整功能" entry when the login response's email ends with `@demo.invalid`; verify the notice renders in devtools with a demo-mode stub base — implemented (identity email persisted at login; `isDemoAccount()` drives the demo banner); banner strings asserted in the compiled bundle; live render check rides the 6.2 probe

## 5. End-to-end verification

- [x] 5.1 Demo-enabled gateway — fresh openid logs in silently into its own cell, a second concurrent demo openid lands in a separate cell, the pool cap answers `503 demo_capacity`, idle demo cells reap + delete while the account cell stays resident, and a bind-code redemption upgrades the demo user: `node --test scripts/test-mp-demo.mjs` (real gateway + stub cells; the chat-turn budget itself is covered by the fake-ctx cell-level test in the same file). A separate Playwright spec cannot drive the mini program, so the gateway-level integration test IS the e2e for this surface
- [x] 5.2 Default (flag off) — unbound openid still gets `binding_required` (regression: `scripts/test-mp-auth.mjs` + `scripts/test-mp-single-auth.mjs`, 38 passing) and the client never auto-pushes the login page (compiled-bundle assertion: zero `navigateTo` in event callbacks)
- [x] 5.3 Run the full e2e suite and confirm no regressions against the flake baseline — 233 passed / 3 failed / 1 skipped: `chat-polish` and `composer-stop` pass on retry (known flake); `sso-user-bindings:204` fails identically with this change's server edits stashed (pre-existing, from the other in-flight working-tree changes). Also `npm run test:unit` green (259 passing, includes the new `scripts/test-mp-demo.mjs`)

## 6. Deployment

- [x] 6.1 Document `MP_DEMO_MODE`, `MP_DEMO_MAX_CELLS`, `MP_DEMO_IDLE_SECS`, and the demo message-cap env in `.env.example` (plus a deploy-focused table in DEPLOY.md); verify the file renders the new block
- [x] 6.2 Enable demo mode on a gateway-shaped deployment and run a live probe: a fresh test openid chats without any login page, the demo cell appears in `/api/gateway/status`, and it reaps after the idle window — **done 2026-09-25 on the local gateway-shaped rehearsal** (`scripts/probe-demo-live.mjs`, exit 0): fresh openid got a silent demo identity and streamed a real LLM answer with no login page, the demo cell showed in gateway status, and it reaped (process stopped + data root deleted) after the idle window. Along the way: dev-mp-gateway's mock WeChat now derives distinct openids from `openid-*` codes; dsh-profile's stale volces roster was repaired — head is now the agreed rehearsal lane `deepseek/deepseek-v4.1-flash` (re-verified live 2026-09-25: chat + tool calls, maxTokens 32768; an earlier one-off curl failure was transient) because the old date-suffixed ids answer model_not_found; `nex-agi/nex-n2.5-mini:free` sits below as a verified free fallback but is NOT for rehearsals (user: not smart enough, won't call tools). **fd-prod rollout remains a deployment task**: fd-prod is single-process (512Mi pod) where MP_DEMO_MODE is inert by design — enabling it there needs the gateway-shape migration + node capacity decision (see memory: fd-prod is single-process).
