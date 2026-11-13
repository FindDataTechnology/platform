# Proposal: add-collapsed-activity-group

## Why

The product's users are mostly non-programmers, but today every assistant turn renders each thinking block and tool call as its own row of collapsible chrome — mono-font tool names, JSON payloads on expand, "运行中/完成" badges per block. A turn that calls five tools buries the answer under five rows of machinery before any text appears. We need a Claude-Code-style master collapse so the transcript shows the answer, not the internals, by default.

## What Changes

- Group consecutive agent-machinery blocks (thinking / tool / skill) of an assistant turn into one **activity group** rendered as a single master-collapsible container; `text`, `error`, and `command` blocks (user-invoked slash-command echoes, e.g. `/model`'s confirmation) always render outside groups, since they are the user-visible feedback, not machinery.
- Activity groups are **collapsed by default**, on both web and mini-program. The existing per-block collapse stays as the second level inside the group.
- The collapsed header is plain-language, no tool names: while streaming it shows live progress ("正在执行第 3 步…"); after the turn it summarizes ("已思考 12 秒 · 执行了 5 步"). Step counts and duration are derived client-side (turn start timestamp), no protocol change.
- A group containing an **errored block auto-expands** on stream end and on history replay, preserving today's "errors are never hidden" rule.
- Streaming sign-of-life moves from the thinking block's live expansion (the `autoOpen` mechanism) to the group header's live status line; thinking no longer streams visibly open.
- Ctrl/Cmd+O (and its in-app toggle-all equivalent) re-targets activity groups: it now expands/collapses all groups rather than bare thinking blocks.

## Capabilities

### New Capabilities
- `chat-activity-collapse`: master collapse for consecutive non-text blocks in an assistant turn — grouping rule, default-collapsed state, plain-language header (live and final), error auto-expansion, applied to both web and mini-program surfaces.

### Modified Capabilities
- `foldable-observation-shortcut`: "Thinking blocks default to expanded" is superseded — visibility is now governed by the default-collapsed activity group; the Ctrl/Cmd+O requirement re-targets activity groups instead of bare thinking blocks.
- `chat-streaming`: the duplicated keyboard-shortcut requirement re-targets activity groups (toggle-all now means groups, since thinking blocks are nested inside).

## Impact

- `packages/core/src/store/chat-store.ts` — group state on assistant turns (collapsed flag per group), `toggleGroup` action, client-side turn-start timestamp for duration; the thinking `autoOpen` fold-on-text-arrival logic becomes redundant and is removed.
- `web/src/components/` — `AssistantTurn` groups blocks and renders a new `ActivityGroup` header; `ThinkingBlock`/`ToolBlock` unchanged inside; i18n keys added in all five locales (`web/src/locales/*/common.json`).
- `miniapp/src/components/TurnView.tsx` + chat page styles — same grouping in Taro components.
- Existing e2e assertions on `tool-block` / `thinking-block` testids keep working (blocks remain in the DOM, nested); tests that expect streaming thinking to be visible-open will need updating.
- No server or WS protocol changes.
