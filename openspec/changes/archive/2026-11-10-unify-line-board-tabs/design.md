## Context

See `proposal.md` — Why. The relevant current shape: `lib/board-adapters.js` produces each line's blocks with a `tab` field; `BoardsPage` filters blocks by a **hand-written** `TABS` table. The two disagree for lex (adapter declares four tabs, table has none), and the table's absence is silent — the page falls back to rendering every block at once.

## Goals / Non-Goals

**Goals**

- One source of truth for a line's tabs.
- A line with nothing to show says so once.
- The host line (base) is explicitly out, not accidentally missing.

**Non-Goals**

- Rewiring any adapter's data source or credential lane (including wiring 萬星's, which stays honest `under_construction` in this change).
- Changing the action gate, the block renderers, or `/boards/:line` routing.
- A new design system primitive: the page keeps `PageShell`, `StatusPill`, `EmptyState` as-is.

## Decisions

### D1 — Tabs are derived server-side from the blocks, and returned with them

`/api/boards/:line` gains a `tabs` array derived from the blocks' declared `tab` values (dedup, first-appearance order). The page renders those and deletes its local table.

Alternatives rejected: (a) keep a frontend table but add a test that compares it — that leaves two sources and only converts a silent bug into a failing test after the fact; (b) derive purely client-side from `data.blocks` — workable, but then the tab set is invisible to any non-web consumer of the board API (the copilot surface already reads boards). Server-side derivation keeps one contract for both.

### D2 — "All blocks under construction" is a page state, not a block state

The rule lives in the page, not the adapter: `blocks.length > 0 && blocks.every(b => b.error === "under_construction")`. Adapters keep declaring honest per-block sentinels; the page decides when the whole line has nothing to say. This keeps adapters simple and lets a line graduate from "whole line building" to "one tab live" with no adapter change — the moment one block gets real data, the tab strip appears.

### D3 — Base is handled by the unknown-line path with distinct copy

No new route, no new adapter. `/boards/base` falls through to the existing not-connected branch; a copy key distinguishes "host line" from "not onboarded yet". Alternative (a hardcoded redirect away from `/boards/base`) rejected: a redirect hides the reason, and the honest-degradation doctrine in this capability is that the page explains itself.

## Risks / Trade-offs

- **[Adding `tabs` to the API response breaks a strict consumer]** → additive field, no removals; the copilot and e2e consumers read `blocks` only.
- **[Whole-line collapse could hide a partially-working line]** → the predicate requires *every* block to be `under_construction`; a single real block restores the tabbed view.
- **[Contract test couples web and server]** → that coupling is the point; it is a node test over the adapter exports, not a browser test, so it runs in `test:unit`.

## Migration Plan

Single deploy. The `tabs` field is additive; the page switches to it in the same commit. Rollback is a revert of `BoardsPage` and the adapter export.

## Open Questions

- Whether 萬星's board should gain a credential lane in a later change (out of scope here; it would move the line out of "whole line building" by itself).
