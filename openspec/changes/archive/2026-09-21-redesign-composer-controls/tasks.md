# Tasks: redesign-composer-controls

## 1. Composer restructure

- [x] 1.1 Restructure `Composer.tsx` card to chips → textarea → single `justify-between` control row; move send/stop into the row's right cluster (`shrink-0`); keep drag-drop, upload flow, and all existing testids. Verify `npm --prefix web run typecheck` and visual check via `npm run web:dev`
- [x] 1.2 Split `ControlStrip.tsx` into left cluster (`+` menu + permission) and right cluster (model, effort, overflow, send/stop adjacency); move workspace and agent `StripMenu`s into the overflow popover as stacked sections (agent only when `agents.length > 1`); all menus keep upward opening. Verify model/effort/permission/workspace/agent switching still round-trips (pending spinner → confirming broadcast) in a live session
- [x] 1.3 Build the `+` menu: attachment entry (same hidden-input click, `composer-attach` testid) and commands entry (existing `openCommands`). Verify upload and slash-picker both work from the menu and drag-drop still bypasses it

## 2. Full-access confirmation

- [x] 2.1 Add ~6 i18n keys ×5 locales (menu labels, dialog title/body/acknowledge/confirm/cancel); verify `npm run check:locales`
- [x] 2.2 Build the confirmation dialog: acknowledgement checkbox gating confirm; cancel/Escape/outside dismiss sends nothing; wire it so only `danger-full-access` passes through it, all other presets apply immediately. Verify by hand: selecting Full access sends nothing until confirmed; `read-only`/`workspace-write` still apply on click

## 3. Width + e2e

- [x] 3.1 Bump `max-w-3xl` → `max-w-4xl` in `Chat.tsx`, `ChatWelcome.tsx`, `Composer.tsx` together; verify transcript/composer alignment at 1280 and 1440 viewports
- [x] 3.2 Update affected e2e specs to open `+`/`⋯` before clicking `composer-attach`/`strip-workspace`/`strip-commands` (expect ~4–6 files, one added step each); add new specs for `+` menu entries, overflow sections, and the confirmation gate (blocked send pre-ack, nothing sent on dismiss). Verify the fast playwright project is green
- [x] 3.3 Full gate: `npm run lint`, `npm --prefix web run typecheck`, `npm run check:locales`, fast e2e project all pass

## Verification notes (implementation)

- **Full gate**: `npm --prefix web run typecheck` clean; `npm run check:locales` clean
  (434 keys × 5 locales); `npx biome check` clean on all 13 touched files; fast e2e
  project **220 passed / 1 failed**, the single failure being
  `e2e/sso-user-bindings.spec.js` (email case normalization in `/api/auth/me`), which
  reproduces with this change stashed and is therefore pre-existing.
- **New spec** `e2e/composer-controls.spec.js` (7 tests): the `+` menu offers both
  entries; the attachment entry opens the composer's own (multiple) file chooser; the
  commands entry opens the same slash picker the typed `/` path does; the overflow
  carries the workspace section and omits the agent section without a catalog; full
  access shows the dialog and sends nothing until acknowledged; dismissing it sends
  nothing and keeps the preset; every other preset still applies on selection.
- **Migrated specs**: `agent-control.spec.js` (6 tests — the agent control moved into
  the overflow; the order test now asserts the two-cluster order the delta spec
  defines; the streaming guard asserts on the agent options, which are buttons),
  `workspace-picker.spec.js` (2 tests — open the overflow first),
  `agent-permission.spec.js` (the full-access selection now acknowledges the dialog).
- **Regression caught and fixed during the gate**: relabelling the `+` trigger
  initially clobbered the shared `common.add` key (every form's submit label), which
  broke five `extensions.spec.js` tests. Restored `common.add` from git; the `+`
  trigger keeps its own descriptive label (`composer.strip.add`), which also avoids a
  role-name collision with those specs' `button name=/^add$/i` selector.
- **Noted, not caused here**: `chat-polish.spec.js` 8.3b/8.4 depend on the previous
  test's real LLM turn having finished; they fail intermittently when the provider is
  slow (verified failing identically with this change stashed) and passed in the final
  run.
