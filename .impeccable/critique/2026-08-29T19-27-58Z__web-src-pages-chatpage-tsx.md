---
target: chat
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-29T19-27-58Z
slug: web-src-pages-chatpage-tsx
---
# Design Critique — Chat Surface (`web/src/pages/ChatPage.tsx`)

Method: dual-agent (A: agent_ed2352da · B: agent_fb0068a2)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Per-tool states excellent; no elapsed time on long runs, and a mid-stream disconnect shows only a 6px dot — composer silently disables |
| 2 | Match System / Real World | 2 | Assistant signs "Find Data Technology" in a Chinese-first personal product; 「清空对话」 clears the view, not the conversation; raw `@doc:` ids render in the user's bubble |
| 3 | User Control and Freedom | 1 | **No stop/interrupt exists anywhere** — no stop message type, send disabled while streaming, no retry/regenerate/edit |
| 4 | Consistency and Standards | 2 | Three icon vocabularies (emoji / lucide / text glyph ⚙); header status dot uses raw Tailwind `bg-emerald-500` while the sidebar uses `success` tokens |
| 5 | Error Prevention | 1 | **Enter fires during IME composition** — confirming pinyin sends the half-typed message; drag-drop and paperclip do different things in the same zone |
| 6 | Recognition Rather Than Recall | 3 | Slash picker with descriptions is good; keyboard help lives only in a vanishing placeholder and a 1.6s toast |
| 7 | Flexibility and Efficiency | 2 | Ctrl+O exists; no composer-focus shortcut, no session search, no copy on prose turns |
| 8 | Aesthetic and Minimalist Design | 3 | Night Workbench discipline mostly holds; leaks: emoji noise and a purple skill edge that violates the one-accent rule |
| 9 | Error Recovery | 2 | Reconnect logic solid; errors render raw English, no retry on failed prompt, mid-stream drop strands `isStreaming` forever |
| 10 | Help and Documentation | 1 | `/help` is a multi-line list flashed in a one-line toast for 1.6 seconds |
| **Total** | | **20/40** | **Acceptable — significant improvements needed before users are happy** |

## Design Specificity Verdict

**LLM assessment:** Half-grounded. The transcript interior is genuinely this product — the rail-hung turn anatomy (`AssistantTurn.tsx:34`, every tool/thinking/skill block hanging on a 1px left rail under one avatar) is a real visual answer to "an agent is working," and the 2px state edges + mono tool names let you scan a finished turn by color alone. But the shell is the default ChatGPT-clone skeleton (240px rail + 768px transcript + docked composer), and the welcome screen is the most generic surface in the product: four English filler prompts sent verbatim in a Chinese-first product. Identity is split three ways: sidebar brands "Platform", the assistant signs "Find Data Technology", the greeting says 「今天我可以帮你什么？」.

**Deterministic scan:** CLI detector: 2 findings, both `side-tab` (`SkillBlock.tsx:13`, `ToolBlock.tsx:36`) — both false positives in intent: the left-edge accent is this product's documented signature pattern (DESIGN.md "Shapes"). Browser injection (headless) found 44 anti-patterns: 1 low-contrast (white on primary blue, 3.6:1 — confirms Assessment A), 40 undersized text (systemic 10px scale), 8 text-occlusion (false positives — text inside its own controls), 1 overused-font (false positive — system stack resolving in headless Chromium, The Invisible Type Rule working as designed).

**Visual overlays:** Injection succeeded headless for evidence collection only — no user-visible overlay persists (temporary server started and stopped; no processes remain).

## Overall Impression

The transcript is a calm, fast, honest place to watch an agent work — then two P0 interaction failures (IME misfire, un-stoppable streams) undermine daily trust in exactly the product whose premise is daily trust. The single biggest opportunity: give the user control of the stream (stop, retry, survive disconnects), because everything else here is already good.

## What's Working

1. **The rail-hung turn anatomy** — one avatar, one left rail, blocks as children. It structurally answers "these tool calls belong to *this* answer."
2. **Performance as design** — 50ms delta batching, memoized turns, lazy Shiki: a transcript that stays smooth after an hour is the Night Workbench promise actually kept.
3. **Composer restraint** — the 16px shell turning Workbench Blue on focus is one quiet signature gesture; the One Lamp Rule mostly holds at surface level.

## Priority Issues

1. **[P0] Enter submits during IME composition.** `Composer.tsx:174` checks only `!e.shiftKey` — confirming pinyin with Enter fires the half-typed message. **Fix:** guard both Enter paths with `isComposing` (and `keyCode 229`); add an e2e composition case. **Suggested command:** `/impeccable harden`
2. **[P0] No interruption; a dropped stream bricks the composer.** No stop control or message type exists (`types/ws.ts`); send disabled while `isStreaming` (`Composer.tsx:321`), `isStreaming` never resets on disconnect. **Fix:** swap send→stop while streaming (at minimum locally finalize the turn); on `disconnected`, finalize open turns and show a reconnect banner. **Suggested command:** `/impeccable harden`
3. **[P1] The most personal text on screen fails contrast.** White on Workbench Blue is 3.6:1 (detector-measured) for the user's bubble (`UserTurn.tsx:6`) and active nav (`Sidebar.tsx:85`) — below the 4.5:1 floor; both assessments converged. **Fix:** darken `--color-primary` toward `oklch(0.53 0.16 250)` and re-derive `primary-foreground`. **Suggested command:** `/impeccable colorize`
4. **[P1] Welcome cards send broken English fragments.** `ChatWelcome.tsx:88-90` sends "Help me write a function that " verbatim, bypassing the composer. **Fix:** prefill + focus the composer instead of sending; localize via the scaffolded `i18nKey`; make prompts product-true. **Suggested command:** `/impeccable onboard`
5. **[P2] Visual system fragmentation.** Emoji in nav/blocks alongside lucide and a text ⚙; purple `border-l-[oklch(0.65 0.20 300)]` skill edge violating the one-accent rule; header dot in raw Tailwind colors; emoji inside locale strings force five-file sync. **Fix:** strip to lucide monochrome, move icons out of i18n strings into config, token-color the header dot. **Suggested command:** `/impeccable polish`

## Persona Red Flags

**Alex (power user):** No composer autofocus; only global shortcut is Ctrl+O — no focus-composer, new-chat, or session search (unusable past ~20 sessions); no copy on prose turns; can't queue a prompt or stop a run.

**Sam (accessibility):** User bubble and active nav fail AA contrast (3.6:1) while muted-foreground passes (~6:1); block toggles lack `aria-expanded`; `aria-live="polite"` on the transcript narrates the streaming firehose; Tab swallowed while slash picker open (mini keyboard trap); emojis read aloud.

**Owner-developer (daily driver):** Draft persists across session switches but is lost on welcome↔chat remount; `/chat/:sessionId` never read — deep links show the wrong session; session sort breaks on mixed epoch/ISO timestamps; model switching is a round-trip out of chat.

## Minor Observations

- Drag-drop uploads to Documents but attaches nothing (no chip, no `@doc:` ref) while the paperclip attaches — route `onDrop` through `onPickFiles`.
- 40 instances of 10px functional text sit below the detector's 11px floor — deliberate density, worth a pass to 11px.
- `/help` as a 1.6s single-slot toast can't be read; consecutive upload toasts overwrite each other.
- Thinking blocks never auto-collapse on done; dead code at `Chat.tsx:41-44`; two cancel paths in `ChatSessionMenu`; `#22272e` code surface remains token debt.

## Questions to Consider

1. During a five-minute tool run, the lamp is the only thing to watch — what if long-running work owned a persistent header status line (current tool, elapsed time, one stop button)?
2. The `/chat/:id` route exists but never loads the session — what if a session were a deep-linkable, exportable *document*, the artifact the owner actually revisits?
3. Who is this assistant to its owner, in one sentence? Answering it fixes the emoji, the identity split, and the English welcome prompts in one stroke.
