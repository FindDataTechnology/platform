---
target: chat
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-30T06-30-52Z
slug: web-src-pages-chatpage-tsx
---
# Design Critique (Round 3 — post P1/P2 queue) — Chat Surface (`web/src/pages/ChatPage.tsx`)

Method: dual-agent (A: agent_a9b0013e · B: agent_f3c2f431)
Questions skipped: user requested no-interruption autonomous runs.

## Design Health Score

| # | 启发式 | R1 | R2 | R3 | Key Issue |
|---|---|---|---|---|-----------|
| 1 | Visibility of System Status | 3 | 3 | 3 | Banner says 「正在自动重连…」 after the 20-attempt budget is spent; no manual retry |
| 2 | Match System / Real World | 2 | 2.5 | 3 | `@doc:` machine tokens leak into the echoed user bubble; 「清空对话」 ambiguity |
| 3 | User Control and Freedom | 1 | 2 | 2 | No regenerate/edit/copy on turns; uploading chip uncancellable; can't draft while disconnected |
| 4 | Consistency and Standards | 2 | 2 | 3 | One icon language, one palette; remaining drift: DESIGN.md's focus ring not implemented on this surface |
| 5 | Error Prevention | 1 | 2.5 | 3 | IME guard + upload send-guard + delete confirm all verified |
| 6 | Recognition Rather Than Recall | 3 | 3 | 3 | Help persistent with live skills; right-click/Shift+F10 undiscoverable |
| 7 | Flexibility and Efficiency | 2 | 2 | 2 | No composer-focus shortcut, no prompt history, no session search |
| 8 | Aesthetic and Minimalist Design | 3 | 2.5 | 3 | One Lamp enforced in code; sidebar footer 6-control stack is the densest region |
| 9 | Error Recovery | 2 | 2 | 3 | Upload failures named; disconnect honest; no retry/regenerate path |
| 10 | Help and Documentation | 1 | 1 | 3 | Persistent dialog, two entries, live skill count; conceptual help (RAG/@doc) still missing |
| **Total** | | **20** | **22.5** | **28/40** | **Good — crossed from Acceptable; the surface is now grounded and product-true** |

## Design Specificity Verdict

**LLM assessment:** Grounded, product-true — the verdict flipped from round 1's "half-grounded". The Night Workbench is legible in shipped code (One Lamp genuinely enforced; state visibility complete across tools/attachments/connection/streaming). All three feature batches landed with one miss each: the multi-line 周报 prompt is clamped to 2 lines; help documents mechanics but not concepts (@doc/RAG); uploading chips lack cancel. Missed opportunities: no message-level actions; `/chat/:sessionId` dead route + refresh loses the transcript.

**Deterministic scan:** CLI: 1 finding — `side-tab` on ToolBlock's state-semantic left edge (the documented signature; only intentional hit remaining). In-page: **low-contrast 0** across rounds 2 and 3; undersized 39 (sidebar 10px timestamps — known), occlusion 8 (viewport artifact), font 1 (system-stack false positive).

## What's Working

1. Complete state-visibility spine — every async operation has a named legible state.
2. Honesty engineering — suppression flag, interrupted-vs-stopped, orphan errors → toasts: values in the state machine.
3. The calm surface is the fast surface — length-only subscriptions, tail-clone memoization, 50ms batching.

## Priority Issues (next queue)

1. **[P1] Accessibility bundle on the live surface** — aria-live flooding on the transcript; no aria-expanded on the three disclosure buttons; Dialog lacks focus trap/initial focus; toast lacks role="status"; copy button invisible to keyboard; DESIGN.md focus ring unimplemented. Fix: scoped live region, aria-expanded, focus management, focus-visible reveals. (`/impeccable harden`)
2. **[P1] No message-level actions** — copy/regenerate/edit-and-resend on turns; the daily retry loop is retyping today. (`/impeccable polish`)
3. **[P2] Uncancellable upload bricks send** — AbortController + X on uploading chips.
4. **[P2] Disconnect honesty + offline hostility** — banner lies after budget; textarea disabled while disconnected (can't draft); add 重试 + keep typing enabled.
5. **[P2] Refresh/deep-links lose the conversation** — wire `/chat/:sessionId`, request current-session history on connect.

## Persona Red Flags (summary)

Alex: no composer-focus shortcut / prompt recall / session search; DOM unbounded in long sessions. Sam: aria-expanded missing, live-region flooding, dialogs don't trap focus, 12px X hit-area, focus ring spec drift (contrast: all AA, destructive 4.56 thinnest pass). Owner: refresh wipes view; stop burns server tokens; welcome recents duplicate sidebar.

## Minor Observations

Dead copy (chat.empty, chat.titleTooLong); Tab swallowed in picker (should accept); locale select → settings popover would fix footer density; 「●」 avatar glyph non-lucide and not aria-hidden; toast single-slot fixed 1.6s.

## Questions to Consider

1. Is the stop button a control or a costume until dsh grows a real interrupt RPC?
2. Should typing `@` surface Knowledge documents the way `/` surfaces skills — RAG as composition, not attachment?
3. What is the product's unit of trust — the view or the history? (/clear wipes silently, refresh wipes accidentally, delete is guarded.)
