# Tasks: redesign-mp-home

## 1. Welcome → showcase

- [x] 1.1 Build the agent-card grid from the store's `agents` (chat-mode entries: name + description, tap = `set_agent` staying on page) with the roster-empty fallback omitting the grid; verify with typecheck + a render-path unit assertion against a roster fixture
- [x] 1.2 Add the positioning line + general-chat quick start and keep the suggested-prompt cards below them; verify typecheck + weapp build
- [x] 1.3 Add the recent-sessions strip (top 3 from the store's session list: title + relative time, tap loads the session via `switch_session`), hidden when empty; verify with a store-fixture unit assertion
- [x] 1.4 Style the showcase (cards, strip, spacing) in app.css at MP density; verify via weapp build + compiled-bundle class assertions

## 2. Status consolidation

- [x] 2.1 Dissolve the auth banner into the welcome as primary "先体验" + secondary "去登录" CTAs; verify bundle assertions (banner classes gone, CTA handlers present, no auto-navigation added)
- [x] 2.2 Reduce the connection banner to a slim tap-to-retry indicator line that hides when connected; verify by simulating connecting/disconnected/connected states in devtools
- [x] 2.3 Make the demo-origin notice a single lightweight line (演示环境 · 退出) above the welcome; verify bundle assertions + devtools with the demo stub base

## 3. Unbound prompt carry

- [x] 3.1 Route unbound suggested-prompt taps into the demo entry with the prompt stashed and applied to the demo draft after the switch lands; verify with a unit assertion on the stash/apply helpers + devtools run against a local DEMO_SANDBOX server
- [x] 3.2 Confirm no prompt message is ever sent from the account deployment by an unbound tap (assert the send path is not reached before the base switch)

## 4. Header micro-interactions

- [x] 4.1 Collapse the chip label to the active agent's name (model moves into the selection panel only); verify devtools render across local/agent/preset states
- [x] 4.2 Minor polish: new-session double-tap guard, composer focus affordance — pick from what surfaces during the devtools pass; verify manually

## 5. Verification

- [x] 5.1 `npm run typecheck` + `npm run build:weapp` + compiled-bundle behavior assertions (showcase strings, CTA handlers, no stacked banner classes, no auto-nav) — all green
- [x] 5.2 Devtools visual + interaction pass over (simulator, live demo origin; screenshots incl. /tmp/mp-home-v2.jpg): bound showcase, unbound showcase (先体验 primary), demo-origin notice, roster-empty fallback, recent strip tap, agent card switch; screenshot saved (/tmp/mp-home-v2.jpg). NOTE: mid-pass this exposed the demo pod's empty roster (GitHub raw unreachable from the cluster) — fixed via the GitOps agents.json ConfigMap mount (fd-infra-deploy 3043d35), re-verified with all four cards rendering. Follow-up recommended: the ACCOUNT deployment keeps the same GitHub-dependent AGENTS_CONFIG_URL; its catalog state needs an authenticated probe and possibly the same ConfigMap treatment.
- [x] 5.3 Full `npm run test:unit` and fast e2e — no regressions vs the flake baseline

## 6. Release

- [x] 6.1 Upload 0.4.0 via wechatide (desc: 首页改版 — 产品橱窗与体验路径) and hand the user the resubmission checklist (self-test path, review-note text, optional demo recording)
- [ ] 6.2 User: submit 0.4.0 for review in the WeChat console with the showcase-first description
