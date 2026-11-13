---
target: chat
total_score: 22.5
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-29T21-03-51Z
slug: web-src-pages-chatpage-tsx
---
# Design Critique (Round 2 — post-fix) — Chat Surface (`web/src/pages/ChatPage.tsx`)

Method: dual-agent (A: agent_bcd7c727 · B: agent_58d23f91)
Baseline: 2026-08-29T19-27-58Z snapshot (20/40) — IME, stop/disconnect, contrast, and identity fixes applied since.

## Design Health Score

| # | Heuristic | Round 1 | Round 2 | Key Issue |
|---|-----------|---------|---------|-----------|
| 1 | Visibility of System Status | 3 | 3 | Banner + stop help, but "正在自动重连…" outlives the 20-attempt budget; no upload progress; `addUserTurnOptimistic` exists in the store but is never called (blank half-second after Enter) |
| 2 | Match System / Real World | 2 | 2.5 | zh copy natural, IME guard correct; welcome prompts still English; 「查看全部」 navigates to the page it's already on |
| 3 | User Control and Freedom | 1 | 2 | Stop exists and Esc/rename/delete all correct — but stop is view-level: the server run keeps going, and a follow-up prompt can bounce off the streaming guard |
| 4 | Consistency and Standards | 2 | 2 | Two status palettes on screen (ChatHeader raw emerald/amber/red-500 vs sidebar success/warning/destructive); emoji vs lucide; two attachment semantics |
| 5 | Error Prevention | 1 | 2.5 | IME guard exactly right; delete-confirm + maxLength good; welcome cards still send fragment prompts; sends bypass the composer's disabled guard when WS is down |
| 6 | Recognition Rather Than Recall | 3 | 3 | Picker with descriptions good; Ctrl+O undocumented; keyboard manual lives in a vanishing placeholder |
| 7 | Flexibility and Efficiency | 2 | 2 | No session search (fatal for daily multi-session), no focus-composer shortcut, Tab-complete swallowed in picker, no copy on prose turns |
| 8 | Aesthetic and Minimalist Design | 3 | 2.5 | Token/density discipline excellent; emoji specks, purple skill edge, and the 6-control sidebar footer undercut the calm |
| 9 | Error Recovery | 2 | 2 | Reconnect machinery solid + orphan errors toast now; but no manual retry after budget exhaustion, no truncation marker on cut-off answers |
| 10 | Help and Documentation | 1 | 1 | `/help` is still a 1.6-second toast |
| **Total** | | **20** | **22.5** | **Acceptable — the P0 blockers are gone; the ceiling is now structural, not broken** |

## Design Specificity Verdict

**LLM assessment:** Half-grounded — same verdict as round 1, but the halves moved. The skeleton remains the category chat template (240px rail, 768px transcript, docked composer). What improved at the tissue level: the composer is now IME-correct ("the draft and pinyin candidates are sacred"), the turn anatomy plus the clone-per-delta streaming state machine and the `suppressed` run-state design were called out as genuine strengths, and white-on-primary-deep computes at 5.1:1 (AA pass). What still blocks specificity: the distinctive blocks (tool/skill/thinking/command) are visually near-synonymous gray rows — the machine's behavior has no visual voice; the welcome screen is borrowed English boilerplate in a Chinese-first product; the local-first positioning is invisible on the surface; and the component layer still breaks its own DESIGN.md rules (emoji icons, the rogue magenta skill edge, dual status palettes).

**Deterministic scan:** CLI: 2 findings, both `side-tab` (`SkillBlock.tsx:13`, `ToolBlock.tsx:36`) — the documented left-rail signature pattern; false positives in intent (and the purple one is already a tracked P2). In-page browser scan: **low-contrast: 0** (round 1: 1 at 3.6:1 — the Workbench Blue split is verified fixed in the rendered DOM); undersized-ui-text 39 (all the 10px sidebar timestamps); text-occlusion 8 (scrolled-out session rows under footer controls — viewport artifact); overused-font 1 (system stack resolving as Roboto — by design).

## Overall Impression

The surface no longer betrays its user at the interaction level — IME, streams, disconnects, and contrast all behave. What remains is a ceiling problem: the product looks like a chat app that has an agent inside it, rather than the workbench its best 30 seconds (watching a legible agent run) promises.

## What's Working

1. **The IME-correct composer** — the `isComposing || keyCode 229` guard plus Esc-dismiss-without-clearing is rare, correct, load-bearing care for a Chinese-first product.
2. **Turn anatomy + streaming state machine** — one rail per turn, clone-per-delta O(1) flushes, and the suppressed-run design for dsh's missing interrupt RPC; design and engineering cohere.
3. **Token and density discipline** — one OKLCH ramp, one blue in two steps, hairlines-not-shadows; the code matches the Night Workbench record almost exactly.

## Priority Issues

1. **[P1] Welcome surface is English and fires half-written prompts.** `ChatWelcome.tsx:25-30` — English literals in the zh-CN-first product; clicking sends "Help me write a function that " verbatim. **Fix:** locale keys + prefill-and-focus the composer instead of sending. **Suggested command:** `/impeccable onboard`
2. **[P1] Attachment paths diverge and uploading is invisible.** Paperclip attaches `@doc:` chips; drag-drop only uploads (`Composer.tsx:125-136` vs `218-234`); no pending state while a PDF ingests. **Fix:** one path, chips with 上传中 → 已附加/失败 states. **Suggested command:** `/impeccable harden`
3. **[P1] Help is a 1.6-second toast; the surface's powers are undiscoverable.** Full command list vanishes mid-read; Ctrl+O documented nowhere. **Fix:** persistent help dialog or welcome section + shortcut sheet. **Suggested command:** `/impeccable clarify`
4. **[P2] Palette fork and the rogue accent.** ChatHeader raw Tailwind colors vs sidebar tokens; `SkillBlock.tsx:13` hard-coded magenta. **Fix:** one-line token swaps. **Suggested command:** `/impeccable polish`
5. **[P2] Transcript amnesia and silent truncation.** Reload flattens history to plain text (tool/skill/thinking evidence lost); disconnect-truncated answers carry no marker. **Fix:** persist block structure or synthesize summary chips; tag truncated turns 「已中断」. **Suggested command:** `/impeccable harden`

## Persona Red Flags

**Alex (power user):** No session search — scroll-hunt within a week of daily use; Tab-complete swallowed in the picker; stop is cosmetic server-side; no copy/regenerate on turns; "＋ 新建" always spawns sessions (list pollution).

**Sam (accessibility):** Block toggles lack `aria-expanded`/`aria-controls`; `aria-live` floods during streams; header status is color-only on a non-focusable span; code copy button invisible to keyboard focus; picker highlight has no `aria-activedescendant`; focus rings exist only in unused primitives — the surface's real controls ship raw. Contrast now passes everywhere it's used (6.0:1 muted text, 5.1:1 white-on-deep), but 10–11px micro text is squint-tier regardless.

**Owner-developer:** No optimistic user turn (blank beat after Enter — the store function exists, unwired); URL never reflects session (`/chat/:id` dead); history flattening destroys the audit trail; DOM grows unbounded in long sessions.

## Minor Observations

Banner copy outlives the reconnect budget (says "正在自动重连…" after attempts exhaust); toast single-slot 1600ms (help/uploads/cold-boot errors cannibalize each other); dead `useChatToggleAll` re-export; placeholder carries the whole keyboard manual; debounced rename fires per typing pause; Ctrl+O hijacks browser open-file undocumented; emoji baked into locale bundles across five languages; `#22272e` debt stands.

## Questions to Consider

1. If stop can't stop the server, is the stop button honest? Would 「隐藏此回答」 labeling beat the silent illusion — or should the protocol grow a real interrupt first?
2. What if the transcript were an artifact, not a stream — persistent, reviewable work logs with tool calls intact, instead of a chat that forgets itself on reload?
3. Can the sidebar footer answer exactly one question ("who am I talking to, on what model, is it alive") — with everything else behind the gear?
