# Tasks: revise-mp-history-ux

## 1. Tap-to-continue (route B)

- [x] 1.1 Wire session rows to continue-in-chat: mark seen → `switch_session` → navigateBack to the chat page; verify in devtools that tapping a row lands on the chat page with the session's turns rendered via TurnView and the composer usable
- [x] 1.2 Retire the read-only viewer (view states `session`/detail rendering + `getChatSession` usage) from the sessions page; verify the page compiles with list-only states and `getChatSession` has no remaining references there
- [x] 1.3 Verify a streaming turn is not lost on switch (the server-side guard applies); manual devtools pass

## 2. Row share affordance

- [x] 2.1 Add the trailing ↗ to each session row (stopPropagation; create token + forward toast; visually consistent with the chat header's ↗); verify in devtools that ↗ shares without opening and the row tap still continues
- [x] 2.2 Keep revoke-only management in the 「我的分享」 group (task 3) and confirm the owner list/revoke flow still works end-to-end

## 3. Collapsible groups

- [x] 3.1 Build the local `Group` component (collapsed-by-default header with count/badge + chevron, expandable body) and re-home the three sections: 我的分享 (tokens + revoke), ⏰ 定时任务 (job count from the cron store; body links to the cron page; unseen badge on the header per the existing `lib/unread` rules), 服务器与高级设置 (server field + save/reconnect); verify all three groups in devtools: counts, badge clearing after viewing, save still reconnects
- [x] 3.2 Remove the old flat sections (share-manage block, bottom cron entry, inline server row); verify no dead styles remain in app.css for the removed classes

## 4. New-session feedback

- [x] 4.1 Make ＋ answer every tap: fresh session → 「已开启新对话」 toast; blank-session tap → 「已是新对话」 toast (idempotent guard stays); verify both cases in devtools

## 5. Verification

- [x] 5.1 `npm run typecheck` + `npm run build:weapp` + compiled-bundle assertions (no viewer strings/classes, group classes present, ↗ row handler present, toast strings present) — all green
- [x] 5.2 Devtools interaction pass: row-tap continue, row-↗ share, groups collapse/expand, badge clear, server save, ＋ feedback both cases; capture screenshots
- [x] 5.3 Full `npm run test:unit` and fast e2e — no regressions vs the flake baseline

## 6. Release

- [x] 6.1 Upload 0.5.0 via wechatide (desc: 历史体验重构 — 点击历史直接继续对话；分享图标化；分组收纳分享链接/定时任务/设置) and hand the user the resubmission checklist
- [ ] 6.2 User: submit 0.5.0 for review in the WeChat console
