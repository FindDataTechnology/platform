## 1. Shared QR-payload parser + web QR rendering

- [x] 1.1 Add `miniapp/src/lib/bind-qr.ts`: `parseBindPayload(raw): { code } | { error }` accepting (in order) a URL whose query carries `bindcode=<6 digits>`, a bare 6-digit payload, and a 6-digit last path segment or fragment; anything else returns a user-readable error. Verify: a unit script (`scripts/test-bind-qr.mjs` or vitest where the miniapp runs them) covering the three accept shapes, digit-prefix URLs, non-6-digit and free-text rejects, and whitespace/whitespace-payload edges.
- [x] 1.2 Add the `qrcode` dependency to `web` and a small `QrCode` presentational component (SVG output, size/level props, no canvas). Verify: renders in isolation (story or unit), and `npm --prefix web run build` stays green.

## 2. Web: dedicated WeChat App settings section

- [x] 2.1 Create `web/src/components/settings/WeChatAppSection.tsx` from the existing `MiniProgramBinding` block: mint via `GET /api/mp/bindcode` (accept: application/json), show the 6-digit code AND the QR of `<origin>/settings/wechat-app?bindcode=<code>` side by side, single-use/5-minute note, refresh affordance, and a manual-entry fallback line. Correct the degraded copy: 401 = "not signed in" (link to login), route-absent = older server hint; both stay quiet and non-blocking. Keep `data-testid="mp-binding-code"` and `mp-binding-refresh` and add `mp-binding-qr`. Verify: `npm run check:locales` after adding all five locale bundles; typecheck green.
- [x] 2.2 Register the `wechat-app` section in `web/src/components/settings/sections.ts` (slug `wechat-app`, after `skills`, before `status`) with i18n keys in all five locales; remove the embedded `MiniProgramBinding` usage from `AccountSection` (keep the component file only if still referenced elsewhere, else delete it). Verify: `/settings/wechat-app` deep-link opens the modal on that section; `/settings` still resolves to `general`; unrecognized slugs still resolve to `general`.
- [x] 2.3 e2e `web/e2e/settings-wechat-app.spec.js`: signed-in user opens the section → asserts the code appears, decodes the rendered QR (e.g. jsqr over a canvas snapshot or the SVG's data payload) and equals `<origin>/settings/wechat-app?bindcode=<code>`; refresh asserts both change; a mocked 401 path asserts the degraded hint. Verify: spec green against `npm run web:build:e2e`.

## 3. Mini program: scan-to-bind login page

- [x] 3.1 Rework `miniapp/src/pages/login/index.tsx`: primary button 【扫码绑定】 (`wx.scanCode`) → `parseBindPayload` → `loginWithBindCode(code)` → success toast + auto-navigate back to chat; scan-no-code shows the parser's error and keeps the form usable. Keep manual 6-digit entry as the visible fallback with the same submit path. Replace the guidance copy to name the web location (site URL, 设置 → 微信小程序) instead of `/api/mp/bindcode`. Verify: devtools walkthrough — mock `wx.scanCode` to return a payload string, assert the REAL `POST /api/mp/login-bindcode` fires (network capture) and the client lands back on chat signed in; a free-text payload shows the error and sends nothing.
- [x] 3.2 Add the guide entry link （查看图文教程） on the login page navigating to `pages/bind-guide/index`; keep 暂不登录 exactly as-is. Verify: walkthrough navigation assertion (route becomes the guide page and back).

## 4. Mini program: bind-guide page

- [x] 4.1 Create `pages/bind-guide/index` (+ `app.config.ts` registration): four ordered steps with CSS/View schematics (browser+address bar, ⚙ settings list with the WeChat App row highlighted, phone+scan frame+QR), the account-origin URL row with copy-to-clipboard + toast (never `DEMO_BASE`), and the trailing 【立即扫码绑定】 action invoking the same scan handler as the login page. Verify: walkthrough asserts the four steps render, the URL row shows the connected account origin, copy toast fires, and the trailing action opens the scanner (mocked capture).

## 5. Mini program: auto-demo landing + bind CTA

- [x] 5.1 In `miniapp/src/lib/runtime.ts`, after `ensureAuth() → binding_required`, auto-switch to the paired sandbox origin when one is known for this build shape (`DEMO_BASE` pairing in `config.ts`; dev builds unchanged), remembering the account origin. One-shot: exiting demo back to the account origin must not re-enter. Verify: walkthrough with a mocked `binding_required` probe asserts the origin switch and a connected demo session with no user tap.
- [x] 5.2 Upgrade the in-demo notice: keep 演示环境 identity + budget text, make the primary affordance 绑定账号解锁完整功能 › (exit demo → restore account origin → re-boot → open the login page with scan ready), keep 退出演示 as the plain exit to the browsable unbound state. Verify: walkthrough asserts both affordances land on the right origins/pages.

## 6. Mini program: connection diagnostics (already coded — verify + test)

- [x] 6.1 The coded-but-uncommitted work lands as-is: `conn-block` on the chat page (address + 修改 + reason line), `noteConnError/clearConnError` in `auth.ts`, error capture in `taro-socket.ts`, login-page `?server=1` auto-expansion and the changed-origin `switchBase()` on save. Verify: devtools walkthrough — dead origin shows address + `request:fail`; 修改 opens the login page with the field expanded and pre-filled; saving a changed origin re-boots against it; a successful connection clears the reason and the block disappears.

## 7. Specs, tests, release

- [x] 7.1 Unit/lint/typecheck sweep: `npm run test:unit`, `npx biome check` on every touched file (pre-existing findings excluded), `npm --prefix web run typecheck`, `npm --prefix miniapp run typecheck`, `npm --prefix miniapp run build:weapp`, `npm run web:build`. Verify: all green against the recorded flake baseline; new failures explained, not retried.
- [x] 7.2 Full MP devtools walkthrough of the complete journey: unbound launch → auto demo → bind CTA → login page → guide page → back → mocked scan → real bind exchange → signed-in chat on the account origin; plus the disconnect diagnostics path. Record the transcript table in the change notes.
- [x] 7.3 Release: web via the standard pipeline (Jenkins → Harbor → GitOps tag bump → ArgoCD); mini program as 0.6.1 upload (version bump + notes; console 提审 stays the user's step). Verify: deployed cell answers `/settings/wechat-app` assets; live probe re-runs clean; upload confirmation captured in notes.
