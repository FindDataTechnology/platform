# Tasks: add-mp-demo-quota-end

## 1. Server signal (server/ws.js)

- [x] 1.1 Add `code: "demo_limit"` to `DEMO_LIMIT_REPLY` and `code: "sandbox_limit"` to `SANDBOX_LIMIT_REPLY`; keep messages unchanged
- [x] 1.2 Attach `budgetLeft` (remaining after this prompt) to `user_echo` for connections under a budget — gateway shape: per-cell remaining for demo-group identities; sandbox shape: per-connection remaining; absent when no budget applies
- [x] 1.3 Surface the error `code` and `user_echo.budgetLeft` in the WS contract types (`packages/core/src/types/ws.ts`) as optional fields

## 2. Core store (packages/core)

- [x] 2.1 Add `demoExhausted: { shape: "cell" | "connection"; message: string } | null` and `demoBudgetLeft: number | null` to the chat store
- [x] 2.2 In `case "error"`: route `demo_limit`/`sandbox_limit` codes to set `demoExhausted` (bypassing `chatErrorSink`) and clear `pendingConfig`; in `case "user_echo"`: store `budgetLeft` and clear `demoExhausted`

## 3. Mini-program end state (miniapp/src)

- [x] 3.1 Wire `setChatErrorSink` to a toast in the MP runtime wiring (app.tsx or lib/runtime boot)
- [x] 3.2 `DemoQuotaCard` component per D4: block-card pattern at the transcript foot, two shapes with their primary actions (`goLogin` / `runtime.reconnectNow()`), dismissible
- [x] 3.3 Chat page: restore the rejected prompt to the draft when `demoExhausted` arrives and the draft is empty; render the card at the transcript foot
- [x] 3.4 Demo line shows 「剩 N 条」 when `demoBudgetLeft` is a number (体验模式 and 演示环境 variants); keeps current copy otherwise

## 4. Tests and verification

- [x] 4.1 Core store test (or e2e seam): `demo_limit` error sets `demoExhausted` shape cell without touching the error sink; `user_echo.budgetLeft` updates the count and clears exhaustion — done as the budget/reply contract unit test (`scripts/test-demo-quota.mjs`, 4/4) + the store routing exercised live in 4.2 (TS store has no node-importable seam; the task allowed either)
- [x] 4.2 Sandbox-path e2e/manual probe: cap a sandbox connection (MP_DEMO_MSG_LIMIT=2 against a local pod), verify the card renders, the draft is restored, reconnect clears it, and a fresh budget accepts a new prompt — verified end-to-end in wechatide: countdown 剩1→剩0, card 「本轮演示额度已用完」+「重新连接继续 ›」, draft restored, reconnect → card cleared → resent prompt accepted with 剩 1 条
- [x] 4.3 Gateway-shape manual probe (demo-group identity): per-cell exhaustion shows the bind-upgrade card; the 体验模式 line counts down — DONE 2026-09-26 via a local full topology: gateway (MP_DEMO_MODE=true, MP_DEMO_MSG_LIMIT=2, stub code2Session) + auto-spawned demo cell; real silent login (wx.login → /api/mp/login → demo identity demo-*@demo.invalid); countdown 体验模式·剩1→剩0, third prompt → 「体验额度已用完」card with 绑定账号 CTA, draft restored
- [x] 4.4 Typecheck + weapp build + wechatide screenshot of both card shapes — both shapes captured (sandbox: reconnect CTA; gateway: bind CTA); typecheck/build/detector green

