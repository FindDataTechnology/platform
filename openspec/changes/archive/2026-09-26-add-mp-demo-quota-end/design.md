# Design: add-mp-demo-quota-end

## Context

The budget machinery exists in one place: `server/ws.js` `attachWebSocket` guards every prompt with either the deployment-wide per-cell budget (gateway shape, `demoBudget.take(ws.user)`) or a per-connection budget (sandbox shape, `ws.sandboxBudget`), answering over-cap prompts with `DEMO_LIMIT_REPLY` / `SANDBOX_LIMIT_REPLY` — bare `{type:"error", message}` objects. The client split happens in `packages/core/src/store/chat-store.ts` `case "error"`: errors with no run in flight go to `chatErrorSink`, which web wires to a toast (`web/src/lib/core-wiring.ts`) and the mini-program never wires — so on the MP the cap reply is a `console.error`, the prompt text was already cleared from the draft, and nothing visible happens. The chat page (`miniapp/src/pages/chat/index.tsx`) already owns both recovery affordances this design needs: `goLogin` (bind upgrade) and `runtime.reconnectNow` (fresh connection), and already renders the demo line that promises 「额度有限」.

## Goals / Non-Goals

Goals: a machine-readable quota event; a first-class client end state with a designed surface per shape (bind-upgrade vs reconnect-resets); draft restoration; a concrete remaining-count display.

Non-Goals: the gateway's connect-time `demo_capacity` rejection (pool capacity, not quota); any web-client surface (web keeps its toast; it consumes the code harmlessly); changing cap values or budget accounting; metering anything beyond user prompts.

## Decisions

### D1 — The signal is a code on the existing error event

`{type:"error", code:"demo_limit"|"sandbox_limit", message}` — no new event type. Rationale: `error` already reaches every client's fan-out; a code is additive and backward compatible (web's sink ignores it today). The two shapes stay distinguishable because their recoveries differ (bind vs reconnect).

### D2 — Remaining budget rides the user echo

For demo-scoped and sandbox connections, the server adds `budgetLeft` to the `user_echo` it already sends on acceptance. No new event; the count is only reported when a budget applies (absent field ⇒ no budget, e.g. bound accounts). The client cannot learn the count before its first prompt — acceptable: the demo line shows the unquantified copy until then, then goes concrete.

### D3 — Client state: `demoExhausted` on the chat store, not a turn block

The store recognizes the two codes and sets `demoExhausted: { shape: "cell" | "connection", message }` (cleared on a subsequent accepted echo or on explicit dismissal). A turn-block rendering would bury the end state in scrollback; a page-level state lets the chat page render the card at the transcript's foot — the exact place the user is looking when their prompt dies. The rejected prompt's text is restored to the draft by the page (it owns the draft state; the store never touches composer state — same boundary as the existing send guards).

### D4 — One card component, two actions

A `DemoQuotaCard` at the transcript foot (paper card, 12rpx, hairline — the block-card pattern; Pocket Blue single primary action per the one-lamp rule): shape `cell` → title 「体验额度已用完」, body explains 演示环境按会话条数限制, primary 「绑定账号解锁完整功能 ›」 (`goLogin`); shape `connection` → title 「本轮演示额度已用完」, body explains 每次连接有独立额度, primary 「重新连接继续 ›」 (`runtime.reconnectNow()` — the sandbox budget is per-connection, so reconnect IS recovery). The card is dismissible and re-appears only on a new quota event.

### D5 — The demo line goes concrete when it can

`demoBudgetLeft` from the echo feeds the existing demo line: 「体验模式 · 剩 N 条」/「演示环境 · 剩 N 条」; no budget info yet ⇒ current copy. Unknown/absent ⇒ never a wrong number.

### D6 — MP wires the error sink as a baseline

`setChatErrorSink(Taro.showToast)` in the MP runtime wiring. Independent of the quota work: any future no-run error at least toasts instead of console-erroring. The quota path bypasses the sink (D3), so the sink fires once per error, not twice.

## Risks / Trade-offs

- **Budget semantics leak into the protocol**: `budgetLeft` is demo-only sugar on `user_echo`; if it complicates the WS contract later, drop D2/D5 first — the end-state card stands alone.
- **Reconnect-as-recovery invites budget farming** (connect, spend 20, reconnect): already true today by design (`SANDBOX_LIMIT_REPLY` literally invites it); the card just makes the existing contract legible. Not a security boundary — the sandbox is the boundary.
- **Draft restoration could surprise** if the user typed a new draft before the error lands: restore only when the draft is empty at that moment; otherwise keep the newer words and drop the old prompt.

## Migration Plan

Purely additive on the wire (new optional field, new optional code). A stale client meeting a new server renders exactly today's behavior; a new client meeting a stale server never sees `budgetLeft`/codes and the card never appears (the generic sink covers it). No data migration, no config.
