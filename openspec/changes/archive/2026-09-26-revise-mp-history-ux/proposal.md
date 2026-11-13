# Proposal: revise-mp-history-ux

## Why

The mini-program's history surface accumulated three parallel implementations:
a read-only sessions viewer (simple bubbles — visually unlike the chat page,
and a dead end: you cannot continue the conversation), a flat stack of
secondary sections at the bottom of the list (share links, cron entry, server
settings), and a share action whose affordances differ per surface (text
button in the viewer, ↗ icon on the home header). The ＋ new-session action
gives no feedback on the welcome state, reading as broken. One history pass
should make "look at the past" and "continue the past" the same action with
one renderer.

## What Changes

- **Tap-to-continue (route B)**: tapping a session row switches the live chat
  to that session (`switch_session`) and lands the user back on the chat page
  — one renderer (TurnView) for live and past transcripts by construction.
  The read-only detail viewer RETIRES from the sessions page.
- **Row-level share affordance**: each session row carries a ↗ quick-share
  icon (create token + forward-card toast), replacing the viewer's text
  button. Token creation semantics unchanged.
- **Collapsible groups** replace the flat bottom stack: 「我的分享 (n)」
  (token list + revoke), 「⏰ 定时任务 (n)」 (entry to the cron page, unread
  badge lives on the group header), 「服务器与高级设置」 — all collapsed by
  default.
- **New-session feedback**: ＋ answers on every tap — a fresh session toasts
  「已开启新对话」; tapping on an already-blank session toasts 「已是新对话」.
- **Home recent strip**: already shipped in 0.4.1 (redesign-mp-home) — listed
  here for completeness, no work in this change.

Non-goals: no server/protocol changes; the MP share PAGE (`pages/share`) and
its forward-card contract are untouched; web surfaces untouched; the cron
management page itself is untouched (only its entry point moves into a group).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `miniprogram-client`: "Session history is browsable" changes from the
  read-only viewer to tap-to-continue-in-chat with a row share affordance;
  new requirements cover the collapsible secondary groups and the
  new-session feedback.
- `scheduled-task-notifications`: "Entry-point surfacing" — the cron entry
  becomes the 「定时任务」 collapsed group in the history page; the unread
  indication moves to the group header (still at the history surface).

## Impact

- `miniapp/src/pages/sessions/index.tsx` (list rows + groups; viewer code
  removed), `miniapp/src/pages/chat/index.tsx` (＋ feedback toast), shared
  group component under `miniapp/src/components/`, `app.css`.
- The unread-badge plumbing (`lib/unread`) is reused on the group header.
- No REST/WS changes; `switch_session` + `session_loaded` already exist.
- Release: next client version (0.5.0) through the normal wechatide upload +
  console review pass.
