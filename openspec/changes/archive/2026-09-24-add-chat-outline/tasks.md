## 1. Web: jump primitives in Chat.tsx

- [x] 1.1 Add `id={`turn-${t.id}`}` anchors to user/assistant turn wrappers in `web/src/components/Chat.tsx` and verify each turn renders a stable id in the browser
- [x] 1.2 Implement jump-to-turn (smooth `scrollIntoView` + set `stickToBottomRef.current = false` + ~1.2s highlight class) and verify manually: jump during streaming keeps position, scrolling back to the bottom re-arms auto-scroll

## 2. Web: outline rail component

- [x] 2.1 Build the outline rail (collapsed edge control + hover-bridge wrapper + expanded card; entries from `turns.filter(user)`, first-line labels; render only at >= 3 user turns; card scrolls vertically for long lists) and verify hover-expand / leave-collapse works across the control-to-card gap
- [x] 2.2 Wire entry hover-detail (full prompt, line-clamped) and entry click (jump via 1.1) and verify both in the browser
- [x] 2.3 Style the rail (opaque card, right-edge placement, `pointer-events` scoped so the transcript stays scrollable) and verify no click interception at the transcript's right edge
- [x] 2.4 Add locale strings for aria-labels (collapse affordance, outline region) to all five `web/src/locales/*/common.json` and verify the web build passes
- [x] 2.5 Add a web e2e spec (threshold gating, hover expand, click-jump releases stick-to-bottom during streaming) and verify it passes in the Playwright harness

## 3. Mini-program: jump wiring

- [x] 3.1 Add `jumpTarget` state in `miniapp/src/pages/chat/index.tsx`: `scrollIntoView={jumpTarget ?? (scrollAnchor ? "msg-bottom" : "")}`, clear `jumpTarget` after the scroll settles, and release `scrollAnchor` on jump; verify via WeChat devtools that tapping a target scrolls to it and streaming does not yank back

## 4. Mini-program: outline rail UI

- [x] 4.1 Add the collapsed edge control and expanded card (tap toggles; entry tap jumps via 3.1 and auto-collapses; "—" collapses without jumping; >= 3 user-turn threshold) and verify the tap flow on the chat page
- [x] 4.2 Style both states in `miniapp/src/app.css` (edge control ~28px, card max-width ~40%, entry ellipsis, jump highlight animation) and verify against the redesigned chat layout at small widths
- [x] 4.3 Verify via wechatide automation (WXML-class assertions: edge control present at 3+ user turns, absent at 2; tap expands card) per the existing MP test recipe

## 5. Wrap-up

- [x] 5.1 Run `openspec validate add-chat-outline` and the full affected e2e suites (new spec + composer/plan suites for regressions); record results
