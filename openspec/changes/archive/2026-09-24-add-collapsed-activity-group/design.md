# Design: add-collapsed-activity-group

## Context

Both surfaces (web `AssistantTurn`, mini-program `TurnView`) render the block list of an assistant turn flat, each thinking/tool/skill/command block owning an `open` flag in the shared `@platform/core` chat store. The store already encodes presentation rules at block level: thinking auto-opens while streaming and folds when the first text arrives (`autoOpen`, chat-store.ts:409-416), errored tools open themselves (`:380`), history replay hydrates tool blocks collapsed except errors (`:528-543`), and `toggleAllThinking` powers Ctrl/Cmd+O. Turns carry no timestamps.

## Goals / Non-Goals

**Goals:**
- One shared grouping + group-state model in `@platform/core`, consumed by both surfaces.
- Plain-language header with live streaming status and a final duration + step count.
- Preserve the existing second-level (per-block) collapse and all existing block rendering inside the group.

**Non-Goals:**
- No WS protocol or server changes; history storage unchanged.
- No settings toggle for "always expanded" groups.
- The `todo_write` plan summary line stays an inner block; pinning a live plan surface outside the group is out of scope.
- No restyling of inner blocks beyond nesting.

## Decisions

### D1: Groups are derived, not persisted
A pure helper in core (`groupTurnBlocks(blocks)`) computes maximal runs of consecutive non-text machinery blocks and returns `{ startIndex, blocks }` per group. Group identity = the run's start block index, stable while blocks stream (a run only grows at its tail; a new run only appears when a text block arrives). The store persists only user overrides: `turn.groupState: Record<number, boolean>` (start-index → open), absent = collapsed. Errored groups need no stored state: "group contains an errored block" is derived, and open-if-error is the default unless the user toggled that group.
*Rationale:* zero migration, history replay works by re-derivation, and the store stays the single source shared by web and MP. *Alternative:* materialize group objects in the turn — rejected because streaming would mutate group arrays every event and persistence would need a schema change.

### D1a: Command blocks stay outside groups
The first cut grouped command blocks along with tool/skill, but the e2e for `/model` caught the regression: a slash command's `command_use` echo IS the command's whole feedback (its `message` carries "Model switched to …"), so folding it hid the user's own action's result behind a header reading "Took 1 steps". Commands are user-invoked feedback, not agent machinery — they render outside groups (like text and error) and open no activity clock.
*Rationale:* the collapse exists to hide AGENT internals; hiding user-requested feedback defeats it.

### D2: Timing is client-side, measured as the activity phase
Record `turn.activityStartedAt` when the first non-text block is pushed and `activityEndedAt` when the first text block arrives (or the turn closes). The header shows that span: streaming "正在执行第 N 步…", final "用时 12 秒 · 执行了 5 步". This satisfies the spec's client-side-measurable thinking duration as the activity phase (thinking leads the phase in practice). Turns from history replay have no timestamps and show the step count only.
*Rationale:* one pair of numbers per turn, no per-block timestamps, no protocol change. *Alternative:* per-block timestamps for exact thinking-only duration — rejected as schema churn for wording precision non-programmers won't audit.

### D3: The `autoOpen` mechanism is removed
Thinking blocks keep `open: true` as their inner default (so expanding the group reveals thinking without a second toggle — the modified foldable-observation-shortcut contract), but nothing streams visibly open anymore: sign-of-life moves to the group header's live status + spinner. The fold-on-text-arrival special case in the store's turn-done path and the `autoOpen` flag are deleted.

### D4: Error auto-expand is immediate and derived
When a tool result with `isError` lands, the store opens the group containing that block (write to `groupState`). On history replay, groups containing errored blocks hydrate expanded (same rule the store already applies to inner tool blocks). A user collapse after that is an explicit override and wins.

### D5: `toggleAllThinking` becomes toggle-all-groups
The action keeps its Ctrl/Cmd+O binding but flips `groupState` for every group in every turn (any-closed → open all, else close all — the existing intent heuristic). Inner block `open` flags are untouched. Web shortcut hook and the store action rename together (`toggleAllGroups`).

### D6: Surface-local rendering
Web: `AssistantTurn` maps `groupTurnBlocks` output; each group renders a new `ActivityGroup` component (header with chevron/spinner/plain text, body = the existing block switch). MP: same helper in `TurnView`, a group `View` with header row and nested block rendering, hardcoded Chinese strings (the MP has no i18n infra today — consistent with its existing text). Web strings go through i18n in all five locales (`turn.activityRunning`, `turn.activityStep`, `turn.activityDone`, `turn.activityErrored`).

## Risks / Trade-offs

- [e2e churn] Tests asserting streaming thinking visible-open or querying tool blocks at top level need updates (blocks are nested and default-hidden; `data-testid`s stay, plus a new `activity-group` testid). → Fix in the same change; the e2e flake baseline memory applies.
- [MP scroll jump] Auto-expand of an errored group mid-stream changes layout height inside the ScrollView. → Keep the scroll anchor logic (`msg-bottom`) as-is; expansion is append-height only, the existing stick-to-bottom behavior absorbs it.
- [Group key drift] A group's start index is stable, but a *replayed* turn re-derives groups; user toggles on live turns don't survive reload. → Accepted: collapse state is ephemeral UI state, same as today's per-block `open`.
- [Plan visibility regression] `todo_write` progress lines are now hidden inside the collapsed group while streaming. → Accepted for the non-programmer audience (header's live step count is the new progress signal); pinned plan surface is a documented non-goal.

## Migration Plan

Client-only change; deploy web bundle + mini-program release together-ish (no cross-version contract — old and new clients just render differently). Rollback = revert both surfaces' render path; store additions (`groupState`, timestamps) are additive and inert without the new rendering.
