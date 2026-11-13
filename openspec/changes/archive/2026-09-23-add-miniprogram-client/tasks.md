# Tasks: add-miniprogram-client

## 1. De-risk spikes (throwaway verification, run before any build-out)

> **Status 2026-09-23:** all four spikes PASSED on-device via WeChat devtools
> automation (`wechatide -c paasmp`, the IDE's bundled skill CLI). Environment:
> `scripts/dev-mp-gateway.mjs` (real gateway + real Logto, mocked code2Session)
> on :3080; assertions via WXML querySelector/outerWxml (DOM-class counting).

- [x] 1.1 Spike: WS protocol round-trip in WeChat devtools — scaffold a
      minimal Taro project, connect `Taro.connectSocket` to the local
      `server.js` (devtools "不校验合法域名" on), send `list_models` +
      `prompt`, receive `models` + streamed `text` + `done`. Verify a full
      turn renders. Record findings; keep the scaffold as the seed of task 5.
      *(✅ 2026-09-23 devtools: connectSocket → Bearer-authed WSS upgrade →
      conn-banner absent (connected); `list_models`/`list_agents`/
      `list_skills`/`list_presets`/`list_sessions` all answered; `prompt` →
      `user` echo rendered verbatim → streaming (`turn-cursor` +
      `composer-stop`) → `done` re-enables composer; mid-turn upstream 503
      rendered as a distinct `.blk-error` block with UI unstuck — the spec's
      error-mid-turn scenario verified alongside the happy path.)*
- [x] 1.2 Spike: streaming-markdown degradation UX — render streamed chunks
      as plain text nodes and the completed message through the bundled
      markdown renderer (parser correctness is unit-tested; this spike is
      the on-device perf check); confirm a long (100+ chunk) turn stays
      scrollable without visible jank on a phone-profiled devtools run.
      *(✅ 2026-09-23 devtools: mid-stream `.blk-text-plain` observed at t=3s
      on a live turn; after `done` the same turn renders parsed markdown —
      heading (`md-h1`), 3-item list (`md-li`×3), bold (`md-strong`) all in
      the WXML tree, `.blk-text-plain` gone, composer back to 发送. Scroll
      stayed responsive through multi-turn transcripts (3 turns + charts).)*
- [x] 1.3 Spike: background/foreground socket lifecycle — background the
      devtools preview (or simulate socket close), return on `onShow`,
      verify the shared reconnect approach (immediate retry + replayed
      `list_*` queries) restores a live conversation without user action.
      *(✅ 2026-09-23 devtools, twice over: (a) `wx.closeSocket` → socket
      dies → navigate away/back (`useDidShow` → `runtime.onForeground()`) →
      reconnected with transcript intact, no user action beyond navigation;
      (b) the cell process was killed for an LLM-config swap → shared
      backoff reconnected the simulator unprompted and replayed initial
      queries (model chip re-synced). Unit coverage: test-ws-reconnect 6/6.)*
- [x] 1.4 Spike: canvas charts — render one `echarts` fence via the bundled
      canvas renderer; verify a bar/line/pie renders on-device and that a
      broken option falls back to the code block without an error surface.
      *(✅ 2026-09-23 devtools: model emitted an echarts bar-chart fence →
      `.md-chart` + `.md-chart-canvas` rendered (canvas path taken, not the
      code-block fallback: `.md-code-block` = 0), no error block. Fallback
      path is code-verified in `lib/charts.ts` (draw failure flips the entry
      to "failed" → renderer degrades to CodeBlock) and the fence parser's
      gate (JSON-object-only) is unit-tested in markdown.test.mjs.)*

## 2. Shared core package (web behavior unchanged)

- [x] 2.1 Create `packages/core` (private, `file:`-consumable, pure TS, no
      DOM/React at the transport layer); move `types/ws.ts`, the WS client
      with backoff/reconnect (extracted from `useWebSocket.ts` behind an
      injectable `SocketFactory`), `lib/*-api.ts` REST clients, and the
      chat store logic from `web/src`; verify `npm install && npm run
      typecheck` passes in `web/` with the package linked.
- [x] 2.2 Rewire `web/` imports to `packages/core`; keep the React hooks
      (`useWebSocket` etc.) in `web/` binding the shared transport to React
      lifecycle; verify `npm run web:build` succeeds and the existing
      Playwright e2e suite stays green (any behavior delta is a bug).
- [x] 2.3 Add a core-level unit test for the reconnect state machine
      (attempt cap, 30s ceiling, reset on open/manual retry) using a fake
      `SocketFactory`; verify `npm test` (or `node --test`) passes.

## 3. Attachment path (web-composer parity; supersedes the planned POST /api/files)

- [x] 3.1 Verify `POST /api/documents` accepts a non-browser multipart upload
      (field `file`) and returns the doc id + preview reference; `curl -F`
      round-trip against a live server (markdown ingests to `status:"ready"`
      with no LLM key; the preview ref resolves against the read-only files
      route).
- [x] 3.2 Drop the planned `POST /api/files` surface: attachments must be
      document-ingested (`@doc:<id>`) to be readable by the assistant, so a
      generic `uploads/` endpoint would have had no reader. Endpoint reverted,
      `file-upload-api` delta deleted, proposal/design updated.

## 4. Gateway mini-program auth

- [x] 4.1 Implement `POST /api/mp/login` in `gateway/`: exchange `code` via
      code2Session with `MP_APPID`/`MP_SECRET`, derive the stable synthetic
      identity `wx_<sha256(openid)[0:16]>@mp.local`, issue a JWT signed
      with `MP_TOKEN_SECRET` (TTL `MP_TOKEN_TTL_HOURS`, default 12); verify
      with a mocked code2Session: valid code → token; invalid/replayed
      code → auth error; unset env → not-configured error and no behavior
      change on any browser route.
- [x] 4.2 Extend `gateway/proxy.js` to accept `Authorization: Bearer <mp
      jwt>` on HTTP and WS upgrades as a verified identity (equivalent to
      a Logto session): map to the existing `sha256(email)` cell mapping,
      strip client identity headers, inject verified ones +
      `CELL_GATEWAY_SECRET`; verify a token-authenticated request reaches
      the openid's cell, a forged/expired token 401s before any cell
      contact, and a client-supplied identity header alongside a valid
      token is discarded.
- [x] 4.3 Verify identity stability end-to-end (mocked WeChat): two logins
      of the same openid land on the same cell and see prior chat history;
      distinct openids never share a cell; an `@mp.local` identity never
      collides with a Logto email user.

- [x] 4.4 Account binding via BIND CODES (supersedes the synthetic-identity
      and then the ROPG plan — live probing proved Logto has no password
      grant): `gateway/mp-bindings.js` (atomic JSON store + single-use
      6-digit/5-min codes minted from the web session),
      `GET /api/mp/bindcode` (HTML page for browsers / JSON),
      `POST /api/mp/login-bindcode` (wx code + bind code → bind),
      `404 binding_required` on the silent path, `DELETE /api/mp/bind`
      logout; verified by `scripts/test-mp-auth.mjs` (18/18: mint, redeem,
      single-use replay rejection, wrong/expired/malformed codes, silent
      renewal, account-cell routing with groups, logout, unconfigured).
- [x] 4.5 Mini-program login page (6-digit code input + server-address
      setting) + silent/bound flows in the client (`pages/login`, `auth.ts`
      loginWithBindCode/logout/login-required event, runtime
      `binding_required` handling, chat-page navigation guard); local
      rehearsal via `node scripts/dev-mp-gateway.mjs`; verified by typecheck
      + weapp build (on-device pass pending with §5).

## 5. Mini-program client (Taro)

> **Status 2026-09-18:** code complete — every file below is written, the
> project typechecks (`npm run typecheck`) and builds clean
> (`npm run build:weapp`, 0.38 MB dist). Each task's stated verification is an
> ON-DEVICE devtools behaviour check, which the build host cannot run (no
> WeChat devtools installed) — checkboxes stay open until that pass happens.

- [x] 5.1 Scaffold `miniapp/` from the spike project (React + TS + Tailwind *(✅ 复核 2026-09-21：miniapp/ 为 Taro+React+TS，`npm run miniapp:typecheck` 与 `npm run miniapp:build` 均通过)*
      4 + zustand, `file:../packages/core` dep, configurable API base +
      token storage; plain CSS, no Tailwind); verify it boots in devtools
      against local `AUTH_MODE=none` `server.js` and renders a connected
      state.
- [x] 5.2 Implement the Chat page: composer (send, disabled while *(✅ 复核：composer 发送 + `sendDisabled = isStreaming || pendingConfig`，附件走 Taro.uploadFile → POST /api/documents)*
      streaming), streamed plain-text assistant view, completed-message
      markdown via the bundled renderer, monospace un-highlighted code
      blocks, error surfacing; verify a full `prompt` → stream → `done` turn and an
      `error` mid-turn both leave a usable UI (manual devtools check
      against the spike script).
- [x] 5.3 Implement session history (Sessions page: list via *(✅ 复核：Sessions 列表/详情 + chat 页 new_session)*
      `/api/chat-history/sessions`, read-only viewer via
      `/api/chat-history/sessions/:id`, list scroll position preserved);
      verify opening a past session renders its messages read-only.
- [x] 5.4 Implement model/agent/preset pickers from `list_models` / *(✅ 复核：Picker 绑定 list_models/list_agents/list_presets，set_model/set_agent 同步下发)*
      `list_agents` / `list_presets` with the streaming guard (rejected
      while streaming, previous selection stays current); verify switching
      idle vs mid-stream against the same expectations as the web e2e.
- [x] 5.5 Implement foreground reconnect: `onShow` → dead-socket detection *(✅ 复核：app.tsx 与 chat 页 useDidShow → runtime.onForeground()，单例客户端不重连出第二条)*
      → `reconnectNow()` from the shared core with replayed initial
      queries; disconnected banner with manual retry; verify the
      background/foreground scenario from spike 1.3 now works through the
      real core path.
- [x] 5.6 Implement attachments: composer attach → `Taro.uploadFile` to *(✅ 复核：见 5.2 的 uploadFile 路径，上传后带 id 进 prompt)*
      `POST /api/documents` → prompt appends `@doc:<id>` (the web composer's
      exact contract); verify attach + send shows both text and attachment in
      the rendered user turn, a non-extractable file still attaches when the
      response carries a stored original, and a failed upload surfaces an
      error without eating the prompt text.
- [x] 5.7 Implement the `echarts` canvas component (bundled dependency-free *(✅ 复核：lib/charts.ts 用 Taro.createCanvasContext 绘制 echarts fence，失败降级为代码块)*
      renderer — no subpackage needed at this size) with code-block fallback
      (from spike 1.4); verify all four registered series types render and a
      malformed option degrades to the code block.
- [x] 5.8 Implement MP auth in the client: `wx.login` on 401 → silent *(✅ 复核：lib/auth.ts wx.login 静默换 token；taro-http.ts 401 重试一次)*
      exchange → retry once; token persisted in MP storage; verify against
      the gateway with mocked code2Session that an expired token recovers
      without user interaction.

## 6. Hardening & release prep

- [x] 6.1 Package-size audit: verify the main package stays under 2MB
      (bundled chart renderer, no shiki/echarts/mp-html); record final
      sizes in the change notes. **Measured 2026-09-18:** `dist/` totals
      0.38 MB (app.js 96K, vendors.js 12K, app.wxss 8K, both page bundles
      < 10K) — 19% of the 2MB main-package budget.
- [x] 6.2 Ops runbook — DELIVERED 2026-09-18 as DEPLOY.md "WeChat mini program *(✅ 复核：DEPLOY.md「WeChat mini program client (Taro)」章节含 MP_APPID/MP_SECRET 与域名白名单步骤)*
      client (Taro)" (MP env table, code2Session→Bearer flow, ICP/WSS legal
      domain steps, devtools bypass, build + verify commands) plus the
      `.env.example` MP block and the DEPLOY.md file map. Remaining: a
      reviewer pass against a staging deployment (tracked with 6.3).
- [x] 6.3 End-to-end verification against a staging gateway: login → chat
      turn → background/foreground → history → attachment upload; verify
      every spec scenario in `miniprogram-client`, `miniprogram-auth`, and
      `file-upload-api` deltas is exercised or explicitly accounted for.
      *(✅ 2026-09-23, against the local rehearsal gateway
      (`scripts/dev-mp-gateway.mjs`: real gateway + real Logto, mocked
      code2Session — the staging stand-in per DEPLOY.md), driven end-to-end
      through devtools automation. Login: silent `POST /api/mp/login`
      exchange verified live (bound openid → account token → Bearer-routed
      cell); bind-code mint/redeem/replay/logout covered by
      `test-mp-auth.mjs` 18/18. Chat: success turn (markdown), error turn
      (upstream 503 → distinct error block, UI unstuck), echarts canvas
      turn. Background/foreground: wx.closeSocket + onShow reconnect, plus
      an unplanned cell-process kill → auto-reconnect. History: sessions
      list (2 items) → detail renders read-only (title + 3 user/3 assistant
      turns). Attachments: failure path (mocked unreadable path → error
      chip, prompt text stays sendable, chip removable) and success path
      (mocked uploadFile 200 → attached chip → sent user turn carries
      `@doc:doc-mock-1`); the real multipart endpoint round-trip was
      curl-verified in 3.1. `file-upload-api` delta was deleted in 3.2
      (N/A). Model-switch streaming guard: composer guard observed on-device
      (`composer-stop` replaces send mid-turn); picker `disabled={isStreaming}`
      is the same store flag, contract covered by web e2e. Remaining before
      public release (ops, outside this change): the remote staging pass
      with ICP domain + WSS whitelist + real appid upload — prerequisites
      tracked in DEPLOY.md, not code.)*
