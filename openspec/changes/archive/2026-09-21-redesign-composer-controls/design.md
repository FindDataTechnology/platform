# Design: redesign-composer-controls

## Context

`Composer.tsx` renders its card as: attachment-chips row → input row (paperclip, textarea, send/stop) → `ControlStrip` row (`flex-wrap` of workspace, agent, model, effort, permission, commands). The archived `chat-composer-controls` spec already requires the strip to "share its row with the attachment and send buttons" — the implementation drifted to its own row. `ControlStrip.tsx` owns the six controls as self-contained `StripMenu` popovers that render store state only and open upward (`bottom-full`). Permission presets apply immediately on click ([ControlStrip.tsx](/Users/chengsishi/paas/web/src/components/ControlStrip.tsx)); the official dsh client gates `danger-full-access` behind an in-page acknowledgement modal. The e2e suite references these controls by stable `data-testid`s (~140 references across 40 files).

## Goals / Non-Goals

**Goals:**
- One bottom control row, two clusters, matching the two reference composers (official dsh seat order; ZCode arrangement).
- Every existing control's semantics, WS contract, testids, and guards (restart spinners, streaming, store-state-only) survive the move unchanged.
- Close the full-access confirmation gap.

**Non-Goals:**
- No plan-mode chip / `/plan` integration (dsh composes plan-mode but that surface is future work).
- No changes to ChatHeader, sidebar, or Settings; no width tokens beyond the shared `max-w-4xl` bump.
- No server or protocol changes of any kind.

## Decisions

### D1 — Restructure `Composer.tsx`, split `ControlStrip` into two clusters

The card becomes: (optional) attachment chips → textarea → one `flex justify-between` row. Left cluster renders the new `PlusMenu` and the existing permission `StripMenu`; right cluster renders model, effort (conditional), the new overflow `StripMenu`, and send/stop (moved from the input row; `shrink-0`). `ControlStrip`'s props (`send`, `onOpenCommands`) are unchanged; its internal layout changes from one wrapping flex to `left`/`right` fragments, and the workspace/agent `StripMenu`s mount inside the overflow popover's children. All menus keep opening upward — the controls now sit in the card's bottom row, which is exactly what upward popovers want. Model label truncates at `max-w-[8rem]`; the row may wrap below the `sm` breakpoint.

*Alternative considered*: keeping workspace on the main row with truncation — rejected: its value is a path basename of unbounded length and it is low-frequency; both references omit it from the row.

### D2 — `+` menu = two entries, both delegating to existing paths

`PlusMenu` is a `StripMenu`-style popover with exactly two items: attachment (calls the existing hidden-input click — same `composer-attach` testid moves to the item) and commands (calls the existing `openCommands`, which inserts `/` and focuses the textarea; the `SlashCommandPicker` text-derived path is untouched, preserving "no second command list"). Drag-drop bypasses the menu as today.

### D3 — Overflow `⋯` popover stacks two sections

One popover, two labeled sections: workspace (the existing recents + path input + native browse block, moved verbatim) and agent (existing list, rendered when `agents.length > 1`). No nested menus — section headers inside a single scrollable popover keep one open/close state machine. Testids (`strip-workspace`, `strip-agent`, …) stay on the controls themselves; only the click path gains an "open `⋯` first" step.

### D4 — Full-access confirmation dialog

A small local dialog component (same outside-click/Escape semantics as `HelpDialog`): title/copy from new i18n keys, an acknowledgement checkbox, confirm disabled until checked, cancel/Escape/mask dismiss. Only the client-side gate — the server's `set_permission` handling, streaming guard, and error routing are untouched. Confirmation is required per selection (no "don't ask again" — matching the official client's one-shot posture).

### D5 — Width bump via shared class change

`max-w-3xl` → `max-w-4xl` in exactly three places: `Chat.tsx` log column, `ChatWelcome.tsx` grid, `Composer.tsx` card — they must move together (the spec's visual alignment of transcript and composer depends on the shared width). Pure styling; no spec text governs the token, so it lives here rather than in a delta.

### D6 — e2e migration is additive

Existing specs keep their testids; the affected ones (`workspace-picker`, `agent-control`, `chat-*` clicking `composer-attach`/`strip-commands`) gain one preceding step to open `+`/`⋯`. New specs cover: `+` menu entries, overflow sections, the confirmation gate (send blocked pre-ack, nothing sent on dismiss).

## Risks / Trade-offs

- [One extra click for attachment, the most frequent `+` action] → Accepted to match both references; drag-drop remains a zero-click path, and the menu keeps attachment as the first entry.
- [Overflow hides workspace/agent discoverability] → Mitigated by the `⋯` chip showing a subtle indicator (e.g. dot) when a non-default workspace/agent is active — cheap, added in implementation if it reads well; not spec'd.
- [Confirmation dialog adds friction to a legitimate escape hatch] → Intentional: `danger-full-access` disables sandboxing; one-time-per-selection acknowledgement matches the official client.
- [Row crowding at `sm` with many controls visible] → Wrap is permitted below `sm`; right cluster is `shrink-0` and model label truncates.

## Migration Plan

Frontend-only, single deploy. Rollback = revert; no protocol or persisted-state implications.

## Open Questions

- Exact `⋯` affordance icon (MoreHorizontal vs. a gear) and the active-state dot from D6 — visual polish during implementation.
