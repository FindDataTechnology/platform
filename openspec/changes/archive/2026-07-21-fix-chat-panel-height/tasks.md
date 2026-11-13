## 1. Layout fix

- [x] 1.1 In `web/src/App.tsx`, change the outer grid to use `h-dvh` (in place of `h-screen`) and add `overflow-hidden`.
- [x] 1.2 In `web/src/App.tsx`, add `min-h-0` to the `<main>` flex column (keep `min-w-0`).
- [x] 1.3 In `web/src/components/Chat.tsx`, add `min-h-0` alongside `flex-1 overflow-y-auto` on the scroll container.
- [x] 1.4 In `web/src/components/Chat.tsx`, replace the `mt-[30vh]` empty-state push with flex-based centering inside the scroll region so the composer stays at the viewport bottom when there are no turns.

## 2. Verification

- [ ] 2.1 Run `npm run web:dev`, open `/chat`, and confirm: (a) empty state — composer pinned to bottom; (b) short chat — no page scrollbar; (c) long chat (send ~30 turns) — only the log scrolls, composer stays visible. *(Manual — needs user to eyeball the running app; Playwright equivalent covered in 2.3.)*
- [ ] 2.2 Resize the browser window (including a short viewport ~500 px tall) and confirm the composer never leaves the viewport and no page-level scrollbar appears. *(Manual — Playwright equivalent covered in 2.3.)*
- [x] 2.3 Add or extend a Playwright test in `e2e/chat-turn.spec.js` asserting that after sending several turns, `document.scrollingElement.scrollHeight === document.scrollingElement.clientHeight` (no page-level scroll) and the `composer-send` button is in-viewport. *(Added as `e2e/chat-layout.spec.js` — two tests, both passing; covers empty state, filler-injected long log, and a 500px-tall viewport.)*
- [x] 2.4 Run the full e2e suite (`npx playwright test`) to confirm no regression in chat, history, documents, or model-selection flows. *(Fast project: 34/34 pass. Two `@smoke` tests need a live LLM and fail identically on main; unrelated to layout.)*
