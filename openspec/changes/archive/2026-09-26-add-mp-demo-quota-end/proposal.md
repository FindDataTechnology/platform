# Proposal: add-mp-demo-quota-end

## Why

The demo line promises 「体验模式 · 额度有限」, but quota exhaustion is invisible: the server already answers over-cap prompts with a friendly limit reply (`DEMO_LIMIT_REPLY` / `SANDBOX_LIMIT_REPLY` in `server/ws.js`), yet the reply arrives as a bare `{type:"error"}` that the mini-program routes to an unwired error sink (`console.error` — `setChatErrorSink` is only wired on web). The reviewer's last impression is silence and a lost draft. The quota-end moment is the demo funnel's conversion point — it must be a designed experience, not an accident.

## What Changes

- **Structured quota signal (server):** both limit replies gain a machine-readable code (`demo_limit` for the per-cell shape, `sandbox_limit` for the per-connection shape) alongside the existing message; demo-scoped `user_echo` events carry the remaining budget so 「额度有限」 can become 「剩 N 条」.
- **Recognized end state (core store):** `chat-store` distinguishes the quota codes from generic errors into a first-class `demoExhausted` state (shape + message), instead of the generic error sink; the mini-program wires `setChatErrorSink` as a baseline (any future unwired error at least toasts).
- **Designed quota-end surface (mini-program):** an inline card in the transcript at the moment the quota hits — 体验模式 shape: 额度已用完 + what happened + 「绑定账号解锁完整功能 ›」; sandbox shape: 本轮额度已用完 + 「重新连接继续 ›」 (a fresh connection resets the per-connection budget). The user's last prompt is restored to the draft instead of vanishing.
- **Concrete budget display:** the demo line shows the remaining count while budget info is available.

Out of scope: the demo cell pool's connect-time capacity rejection (`demo_capacity` in `gateway/spawner.js`) — capacity, not quota; and the web client's quota display (web already toasts; it gets the structured code for free but no new surface this change).

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mp-demo-mode`: the message-cap requirement's limit reply becomes a coded event, and the client obligations grow from "a visible notice" to a designed exhaustion surface (end-state card, upgrade CTA, draft restoration, remaining-count display) for the per-cell shape.
- `mp-demo-sandbox`: the per-connection cap requirement gains the same coded event and client end-state, with its own recovery affordance (reconnect-resets-budget instead of bind-to-upgrade).
