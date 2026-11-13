# Proposal: redesign-composer-controls

## Why

The composer currently stacks three rows inside its card — attachment chips, then input row, then a wrapping `ControlStrip` of up to six controls on its own line — which crowds the bottom of the chat and drifts from the `chat-composer-controls` spec's own "SHALL share its row with the attachment and send buttons" requirement. Both reference surfaces the user named (the official dsh client and ZCode) converge on one bottom row with a left context cluster and a right runtime cluster. Separately, selecting `danger-full-access` applies immediately with no confirmation — a security gap versus the official client, which gates it behind a risk acknowledgement.

## What Changes

- **One control row, two clusters**: the card becomes textarea on top and a single bottom row `justify-between`. Left cluster: a `+` button opening a menu with「上传文件」(triggers the existing file input/upload path) and「命令」(the existing slash-command trigger), plus the permission chip. Right cluster: model chip, then effort chip (when the model declares levels), then an `⋯` overflow menu, then send/stop.
- **Overflow menu**: the `⋯` popover stacks the existing workspace picker (recents, path input, native browse) and the agent list (>1 agents) — the two low-frequency, long-label controls leave the main row. All `data-testid`s are preserved.
- **Full-access confirmation**: selecting `danger-full-access` (displayed as "Full access") opens a localized risk-confirmation dialog with an acknowledgement checkbox; `set_permission` is sent only after acknowledgement. All other presets keep immediate apply. Server behavior is unchanged.
- **Width**: the transcript, welcome grid, and composer card widen together from `max-w-3xl` to `max-w-4xl` (896px), accommodating the chat column narrowing beside the plan panel and matching the reference composers' proportions.
- Popovers keep opening upward; drag-drop upload, store-state-only rendering, restart spinners, streaming guards, and every existing control's WS contract are unchanged.

## Capabilities

### New Capabilities
<!-- none — this change modifies existing capabilities only -->

### Modified Capabilities
- `chat-composer-controls`: the strip-layout requirement is rewritten for the two-cluster single row (left: `+` menu + permission; right: model, effort, overflow with workspace/agent, adjacent to send/stop); the commands-control requirement now enters through the `+` menu instead of a dedicated strip button.
- `permission-mode-selection`: the preset-switch requirement gains the client-side acknowledgement gate for `danger-full-access` before `set_permission` is sent; all other behavior (live switch, streaming guard, restart reset, WS contract) unchanged.

## Impact

- **Web only**: `Composer.tsx` (row structure, `+` menu), `ControlStrip.tsx` (cluster split, overflow menu), a new confirmation dialog component, `Chat.tsx`/`ChatWelcome.tsx`/`Composer.tsx` width classes. No server, protocol, or store changes.
- **i18n**: ~6 new keys × 5 locales (menu labels, confirmation dialog copy).
- **e2e**: all existing `data-testid`s preserved; specs that click `composer-attach`, `strip-workspace`, or `strip-commands` need to open the `+`/`⋯` menu first (~4–6 files, one added step each); new specs for the menu entries and the confirmation gate.
- **Compatibility with `add-plan-progress-panel`**: independent; the `< lg` plan dock from that change sits above the textarea and is unaffected by the control-row restructure.
