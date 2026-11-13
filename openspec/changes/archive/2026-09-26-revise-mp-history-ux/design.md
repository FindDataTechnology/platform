# Design: revise-mp-history-ux

## Context

The sessions page (miniapp/src/pages/sessions/index.tsx) currently holds: a
REST session list, an in-page read-only viewer (flat bubbles, its own
rendering), a flat share-manager section, a bottom cron entry, and a server
row. The chat page owns the rich TurnView renderer and the live WS
(`switch_session` → `session_loaded` already broadcasts full turn payloads).
`lib/unread` provides the unseen-session plumbing used by the ☰ badge. Route
B was chosen over keeping a preview page: unify by having ONE renderer.

## Goals / Non-Goals

**Goals:** one action ("tap a session") that both views and continues the
past; one transcript renderer; secondary surfaces tidied into collapsed
groups; every header action answers a tap.

**Non-Goals:** server/protocol changes; the public share page; the cron
management page's internals; web parity work; swipe-cells (no native MP
support).

## Decisions

### D1 — Tap-to-continue instead of preview + button (route B)

Tapping a row: mark seen (existing helper) → `runtime.send({ type:
"switch_session", id })` → `Taro.navigateBack()` to the chat page. The WS
`session_loaded` payload drives the chat store; the chat page renders it with
TurnView — UI unification is structural, not a styling exercise. The
read-only viewer and its REST fetch (`getChatSession`) retire from this page;
REST remains for the LIST (works while the socket is down — unchanged).
Rationale vs route A (preview + continue button): one fewer hop, no second
renderer to keep in sync; the switch is non-destructive (＋ starts fresh
anytime).

### D2 — Row share affordance replaces the viewer's text button

Each row gets a trailing ↗ (stopPropagation from the row tap): create token →
toast (forward via ⋯), same semantics as the home header's ↗. Revoke stays in
the 「我的分享」 group — management and quick-create are separate intents.

### D3 — Collapsed groups under the list

A small local `Group` component (header with count/badge + chevron, body
rendered on expand; collapse state is per-page-visit, no persistence).
Groups: 我的分享 (tokens + revoke), ⏰ 定时任务 (count of jobs from the cron
store; body links to the cron page; unseen badge per the notifications spec),
服务器与高级设置 (server field + save). Default collapsed all — the list is
the page's product.

### D4 — ＋ feedback, not a menu

Folding ＋ into a top-right menu was rejected: the native WeChat capsule (⋯)
already sits there (confusion + proximity), and new-session is high-frequency
(one extra tap forever). Instead every tap answers: fresh → 「已开启新对话」
toast; blank → 「已是新对话」 toast. The blank-case idempotence guard from
redesign-mp-home stays; only the silence goes.

### D5 — Release vehicle

Client-only → 0.5.0 via the established upload + review pass. No server
coordination.

## Risks / Trade-offs

- [Losing the "peek without switching" preview] → accepted per route B;
  switching is reversible and cheap; the home recent strip covers quick
  re-entry.
- [Row tap vs row-↗ mis-taps] → the ↗ hit area is generous but visually
  distinct; the failure mode (share toast while intending to open) is
  recoverable and side-effect-light (a token, revocable).
- [Group counts need data on page open] → shares already load via REST; cron
  job count comes from the cron store the cron page already uses (WS
  `cron_jobs`); neither adds a new request shape.
- [session switch while streaming] → the existing streaming guard applies
  (switch_session already handles in-flight turns server-side, same as the
  chat page's session switching).

## Migration Plan

Pure client change; ship 0.5.0. Rollback = previous client version. No
state, no flags.

## Open Questions

- Group component reuse potential for the chat page's future surfaces —
  deferred; build it local to the history page first.
