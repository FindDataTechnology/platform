# add-mp-scan-bind — verification notes

## What was verified, and how

| Layer | Suite | Result |
| --- | --- | --- |
| Scanned-payload parsing | `scripts/test-bind-qr.mjs` (13) | the three accepted shapes (URL query → bare digits → last path segment/fragment) plus the ones a real camera produces: a scheme-less host, an IP-literal origin whose digits must not be mistaken for the code, extra query parameters, 5/7-digit rejects, free text, whitespace-only (its own message) |
| QR rendering | `scripts/test-qr-svg.mjs` (4) | the module matrix re-derived from the emitted SVG path equals the encoder's matrix for the same text (so the code tracks the URL it was given), `size` scales only the drawing, `level` reaches the encoder |
| Web section (code + QR, refresh, degrades) | `e2e/settings-wechat-app.spec.js` (4) | a real mint against a real forward-auth deployment; the rendered SVG rasterized and read back with **jsQR** decodes to exactly `<origin>/settings/wechat-app?bindcode=<code>`; refresh re-mints digits **and** QR; a 401 degrades to the sign-in hint while the rest of Settings stays usable; the declared section order and the `/settings` + unknown-slug fallbacks |
| Settings surface | same spec + `e2e/settings-modal.spec.js` | `/settings/wechat-app` deep-links onto the section; `/settings` and an unknown slug still resolve to `general`; the six declared sections appear in the declared relative order |
| Mini program (whole journey) | devtools walkthrough (below) | unbound launch → auto demo → notice → bind CTA → login page → guide page → copy → mocked scan → **real** bind exchange → signed-in chat on the account origin; plus the unscannable-payload and disconnect-diagnostics paths |
| Locale parity | `npm run check:locales` | 618 keys × 5 locales OK |
| The gate the pipeline runs | `npm run web:build` | `check:locales` + `vite build` green; the section's lazy chunk is 27 KB raw / **10.4 KB gzip** (matches design.md's estimate; nothing added to the main bundle) |
| Typecheck + MP build | `npm --prefix web run typecheck`, `npm --prefix miniapp run typecheck`, `npm --prefix miniapp run build:weapp` | green |
| Lint | `npx biome check` on every touched file | new files clean. Remaining findings are pre-existing: `sections.ts` carries 8 `noExplicitAny` warnings in the registry's `LazyExoticComponent<any>` idiom (7 before this change, my entry is the 8th of the same kind), and `chat/index.tsx`'s `useExhaustiveDependencies` on the charts effect is untouched deliberate-trigger code from HEAD |
| Full unit suite | `npm run test:unit` | **412/413**. The one failure is `test-cell-gateway.mjs`'s reaper assertion (a load/timing flake of the 51-file parallel run — it passes 2/2 standalone, 57 s; no file this change touches is on that path) |

## Mini-program devtools walkthrough (tasks 3.1, 3.2, 4.1, 5.1, 5.2, 6.1, 7.2)

Environment: a hermetic **account** cell on `:3310` (`scripts/mp-bind-cell.mjs`) — the real `server.js` in `AUTH_MODE=logto` with MP credentials, a mock `code2session` that resolves every `wx.login` code to one known **unbound** openid, and a `POST /__bind` route that mints a real single-use code through the deployment's own `/api/mp/bindcode` (authenticated by a session cookie signed with the deployment's secret). The sandbox leg is the **real** production pairing: `DEMO_BASE` in the production-shaped build is `https://demo.finddatatech.cloud`. Simulator origin set through the app's own storage (`platform.baseUrl`); assertions are WXML class counts and element text (Taro strips `data-testid`).

| Step | Evidence |
| --- | --- |
| Unbound launch lands in the sandbox with no tap | after a cold boot against `:3310`: `platform.baseUrl` = `https://demo.finddatatech.cloud`, `platform.preDemoBase` = `http://127.0.0.1:3310`, no token — and the demo pod's own roster arrived over `wss://demo.finddatatech.cloud/` (agents/models/presets/permissions) |
| One notice line, both affordances | `.demo-line` = 1: `演示环境 · 数据定期清空` + `绑定账号解锁完整功能 ›` + `退出演示 ›`; `.conn-line` = 0 (connected). Screenshot: `/tmp/wt-final-demo.jpg` |
| 退出演示 is a plain exit and does not bounce back | base restored to the account origin, `preDemoBase` cleared, and it **stays** there (`退出演示` is one-shot per run — no re-entry) |
| 绑定账号解锁完整功能 ends on the login page | base restored + `preDemoBase` cleared + page stack `pages/chat/index,pages/login/index` |
| Login page is scan-first with a manual fallback | `.login-scan` / `.login-guide` / `.login-code-input` / `.login-skip` / `.login-submit-ghost` = 1 each; the guidance copy names the **web location** (「http://127.0.0.1:3310」+「设置 → 微信小程序」) and no bare API path |
| Guide page: four steps, account origin, copy | route `pages/bind-guide/index`, `.guide-step` = 4 (open browser → sign in → 设置 → 微信小程序 → back to the phone); step-1's address bar and the URL row both read `http://127.0.0.1:3310`; `demo.finddatatech.cloud` appears **nowhere** in the page; copy → clipboard = `http://127.0.0.1:3310` and the affordance flips to `已复制` |
| Mocked scan → the REAL bind exchange | `wx.scanCode` mocked to `http://127.0.0.1:3310/settings/wechat-app?bindcode=852569` (a freshly minted real code) → tapping `立即扫码绑定` produced a real `POST /api/mp/login-bindcode`: `platform.mpToken` set, `platform:login-email` = `walkthrough@corp.com` (the account the code was minted for), reLaunch to chat, `.conn-line`/`.conn-note`/`.welcome-cta`/`.demo-line` all 0, and the account origin's `ws://127.0.0.1:3310/` session answered with `user_bindings` |
| The code really is single-use | replaying the same code over curl: `{"error":"绑定码无效或已过期"}` |
| An unscannable payload says so and sends nothing | `wx.request` instrumented: free-text payload → `.login-error` = `未识别到 6 位绑定码，请在电脑上打开平台「设置 → 微信小程序」后重新扫码`, recorded calls = **[]** |
| Disconnect diagnostics name the server and the reason | dead origin `:3319`: `.conn-block` with `服务器 http://127.0.0.1:3319` + `修改` and `.conn-note` = `request:fail` |
| 修改 opens the real editor pre-filled | login page opens with the server field **expanded**, `value="http://127.0.0.1:3319"` |
| Saving a changed address re-boots against it | field edited to `:3310` + `保存并重连` → `platform.baseUrl` = `http://127.0.0.1:3310`; after the re-boot `.conn-line` = 0 and `.conn-note` = 0 (a successful connection clears the reason and the block) |
| Simulator left in a clean state | origin restored to `https://craw.finddatatech.cloud` with token/email cleared; the cold boot then silently re-bound the same openid (the simulator's own bound account) and connected |

### Two defects the walkthrough caught (both fixed in this change)

1. **The in-demo notice never rendered on the automatic entry.** `demo` was captured at mount — from the *account* origin, before the runtime switched — and only the explicit 先体验 path ever set it. On the auto path the user got the sandbox with no 演示环境 identity and, worse, no bind CTA. Fixed by re-reading `isDemoAccount() || isDemoBase()` at the same moment the connection comes up.
2. **The disconnect reason line stayed blank on a plain boot.** React runs passive effects later than a refused connection fails, so the first reason landed after the initial read and before the subscription — and `noteConnError` dedupes identical reasons, so no later retry re-announced it. Diagnosed by experiment: against an origin that fails with a *different* text (`404 login failed`) the line appeared, against the refused origin (`request:fail`) it did not. Fixed by reading `authError()` once when the subscription goes live.

The harness needed one fix of its own while doing this: `scripts/mp-bind-cell.mjs` must take its child `server.js` down on a signal, or a later rehearsal silently probes the *previous* deployment still holding the port.

## Release (task 7.3)

**Mini program — done.** `wechatide -c paasmp upload --project miniapp/dist --upload-version 0.6.1`
→ `confirmation_upload_6d523dfc-2a01-4481-af20-bcd85f24d7ed` → polled to `status: "success"`
(total size **1,069,191 B**, against 0.6.0's 1,014,881 B — the new bind-guide page and the scan path).
The uploaded bundle is the production-shaped build (`build:weapp` after every source edit; the build is
newer than every file under `miniapp/src`), and the simulator was left pointed at
`https://craw.finddatatech.cloud` with token/email cleared, where its cold boot silently re-bound the
same openid and reconnected. Console 提审 stays the user's step, as the task says.

**Web — shipped 2026-09-28.**

| Step | Result |
| --- | --- |
| Commit | `b600011` — this change only, 38 files. The sibling change's 33 entries stayed unstaged: for the five locale files the worktree keeps their `resources.binding.*` block while the commit carries only this change's keys (verified by re-implementing `check:locales`'s key-set comparison over the **index** blobs: 560 keys × 5, no missing/extra) |
| Release branch | `gitee/deploy/prod-snapshot` fast-forwarded `ea802e5 → b600011` (the two in-between commits are docs + the openspec archive only) |
| Jenkins | triggered via the generic webhook (`token=platform`); build **#32** checked out `b6000116137f026ea6d0525f351559d60419d3e3`, `Finished: SUCCESS`, `Pushed 100.64.0.8:30880/paas_private/platform:sha-b600011` |
| GitOps | `fd-infra-deploy` commit **`0d04e18`**: `all-services/prod/platform.yaml` `sha-ea802e5 → sha-b600011` (the repo's unrelated dirty `mcp-cheap/` file left untouched); ArgoCD refreshed → `Synced` at `0d04e18`; `deployment "platform" successfully rolled out`, pod `platform-86bbdddffc-9xg2s`, **0 restarts** |
| Deployed assets | `/assets/WeChatAppSection-CbzN9wBk.js` → **200, 28,256 B**, carrying `mp-binding-qr` / `mp-binding-code` / `mp-binding-refresh`, `shape-rendering="crispEdges"` (the QR renderer) and the `settings/wechat-app` URL builder. Its hash differs from the local build's because the local one also contained the sibling change's web code — the image carries this commit's tree only, which is the point of the hunk-only commit |
| Gating intact | `/settings/wechat-app` anonymous → 302 (Logto's login gate), `/api/mp/bindcode` anonymous → 401, `/api/config` → 200, `/api/auth/me` → `mode: logto` |
| Sandbox leg (what the auto-entry now depends on) | `demo.finddatatech.cloud/api/auth/me` → `mode: none`; anonymous `POST /api/documents` → 403 (`演示环境不支持上传文档…`); an anonymous `wss://demo.finddatatech.cloud/` opens with **no identity sent** and receives the full roster (`current_model`, `agents`, `sessions`, `permissions`, …) — the "no login, no popup" contract, unchanged by this release |

One correction to the plan above: `scripts/probe-demo-live.mjs` is the probe for the **gateway-shaped** `MP_DEMO_MODE` (multi-tenant cells), and fd-prod is single-process, where that mode is inert by design — so it is not the right post-deploy check for the sandbox pod. The direct checks in the table above (mode `none`, uploads refused, anonymous WS with a full roster) are what actually pins the sandbox contract.

## Notes for the next reader

- **The shared tree is shared.** Mid-verification, `web/src/locales/en/common.json` was rewritten by the other in-flight workstream's snapshot: it arrived carrying their `resources.binding.*` keys, but without this change's `settings.wechat-app.*` block and with the retired `settings.account.mp.*` restored — `check:locales` went from green to 88 drift entries with no local cause. Repaired with anchored edits that keep their block intact; parity is 618 keys × 5 again. Land this change with hunk-only commits (see the sibling change's recipe) and re-run `check:locales` on the deployable tree before building.
- **A spec/code drift this change does not resolve.** The `settings-surface` delta enumerates six sections (General, Models, MCP, Skills, WeChat App, System Status) with `wechat-app` inserted after `skills`. The shipped surface also carries the **Account** section (email + logout, the only logout affordance in the web UI, with e2e coverage in `logto.spec.js` / `auth-catalog.spec.js`), which the canonical spec has never listed — the delta inherited that omission from the pre-existing spec rather than deciding to drop the section, and its Non-Goals explicitly say the Account section is not reworked beyond losing the embedded MP block. Implementation therefore keeps Account and its position (before Models); the e2e asserts the declared sections' *relative* order rather than the modal's exact list. Reconciling the canonical spec's list with the shipped surface is a separate, smaller change.
- **Auto-demo is one-shot per app run, not per install.** The guard is module state, so a fresh launch re-evaluates: an unbound user always lands in the sandbox, while a deliberate 退出演示 (or a hand-edited server address) is never undone by the next boot inside that run. If the sandbox cannot hand out a session, the account origin is restored and the ordinary unbound state shows — the sandbox is an entry route, never a trap. Dev builds pair `localhost:3000` for both origins, so the guard is false there and nothing changes.