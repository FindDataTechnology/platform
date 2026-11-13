## 1. Baseline

- [x] 1.1 Run the full e2e suite on the current build and record which specs pass, fail, and flake — the "invalid model id shows error" case in `model-selection.spec.js` is a known pre-existing flake, and later runs must be read against this baseline, not against an assumption of green
- [x] 1.2 Grep `web/src/` for literal color classes that will not adapt to a theme (`bg-black/`, `bg-white/`, `text-white`, `text-black`, and any raw hex or `rgb(` in className strings) and record the list — the mobile drawer backdrop in `App.tsx` is one known case

## 2. Theme foundation

- [x] 2.1 Spike `light-dark()` against Tailwind v4's opacity modifiers: convert one token to `light-dark(...)`, apply it via a `bg-*/95` utility (as `ChatHeader` uses today), and confirm the generated `color-mix()` resolves correctly in both schemes. If it does not, fall back to the duplicated `[data-theme="light"]` / `[data-theme="dark"]` block approach for the rest of section 2 and note the switch in `design.md` §D4
- [x] 2.2 Convert every token in `web/src/styles/globals.css` to `light-dark(<light>, <dark>)`, keeping today's values as the dark half so dark mode is pixel-identical, and author the light half as a complete set — no token may be defined in one palette and missing from the other
- [x] 2.3 Add the `color-scheme` rules: `:root { color-scheme: light dark }`, `[data-theme="light"] { color-scheme: light }`, `[data-theme="dark"] { color-scheme: dark }`, so the system case resolves with no JavaScript and native scrollbars and form controls follow the palette
- [x] 2.4 Add the pre-paint inline script to `web/index.html` that reads the stored theme from `localStorage` and sets `data-theme` on `<html>` before the bundle executes; absence of a stored value must leave the attribute unset so the system case applies
- [x] 2.5 Add a `useTheme` hook exposing the current choice (`light` / `dark` / `system`) and a setter that writes `data-theme` and `localStorage`; selecting `system` must remove the stored value rather than writing the string, so "no value" and "system" are the same state
- [x] 2.6 Convert `Markdown.tsx`'s Shiki highlighter to dual-theme output: register `github-light` alongside `github-dark-dimmed`, render with `themes: { light, dark }` and `defaultColor: false`, and add the CSS rule that selects between the emitted `--shiki-light` / `--shiki-dark` properties
- [x] 2.7 Fix every literal color found in task 1.2 to use a semantic token
- [x] 2.8 Walk all five nav surfaces in light mode and fix contrast and border regressions — text must meet WCAG AA against its background, and hover, focus, active, disabled, and selected states must each stay distinguishable from resting

## 3. Settings modal

- [x] 3.1 Add the section registry: five entries (`general`, `models`, `mcp`, `skills`, `status`) with stable slugs, i18n label keys, icons, and lazily-imported components — one source of truth that both the modal chrome and the route table read
- [x] 3.2 Build the modal shell from the existing `web/src/components/ui/` primitives (no new dependency): backdrop, panel, section list, close control, focus trap, and focus restoration to the triggering control on close
- [x] 3.3 Wire `/settings/:section` routing in `App.tsx` using the background-location pattern so the underlying view stays mounted; `/settings` and any unrecognized slug resolve to `/settings/general`; a direct load with no background location renders `/chat` beneath
- [x] 3.4 Implement the dismiss paths — Escape, backdrop click, close control — so that each navigates back to the background location and leaves no `/settings/*` URL in the address bar
- [x] 3.5 Add the `Cmd + ,` / `Ctrl + ,` global shortcut, registered alongside the existing `Cmd/Ctrl + O` handler in `App.tsx`
- [x] 3.6 Mount `ModelsPage`, `ExtensionsPage` (as both the `mcp` and `skills` sections), and `DashboardPage` as section panes with their internals, controls, and `data-testid` attributes unchanged; adjust only the container chrome the pages assume
- [x] 3.7 Build the General section with the theme control from task 2.5 and the locale control relocated from the sidebar footer, preserving `data-testid="locale-select"`
- [x] 3.8 Repoint the System Status "Manage" links at Settings sections, and handle the asymmetry: the MCP and Models links switch panes inside the open modal, while the Agents link targets `/agents` and therefore closes the modal
- [x] 3.9 Add the legacy redirects — `/models`, `/mcp`, `/skills`, `/extensions`, `/extensions/mcp`, `/extensions/skills`, `/dashboard` — each to its canonical `/settings/:section` URL, leaving no legacy path rendering a pane at its old address
- [x] 3.10 Add all new i18n keys (section labels, theme options, modal chrome) to all five bundles — `en`, `zh-CN`, `es`, `fr`, `ja` — and confirm the `check-locales` build guard passes

## 4. Shell reduction

- [x] 4.1 Reduce the sidebar nav to Chat, Knowledge, Agents, Bots, Trace, keeping label resolution through i18n and stable identity, ordering, and icons across locales
- [x] 4.2 Collapse the sidebar footer to a single row containing the connection status indicator and the settings gear, removing the agent `<select>`, the model chip, the "Clear chat" button, and the locale `<select>`
- [x] 4.3 Delete `SettingsMenu.tsx` and its popover-specific i18n keys, now that the gear opens the modal
- [x] 4.4 Add the agent control to the ControlStrip between workspace and model; it reflects the store's `currentAgent` with no optimistic local state and is rejected while streaming, but shows **no** pending spinner — `switchAgentTo` broadcasts synchronously with no dsh restart, unlike the other controls. Render it only when two or more switchable agents exist (design §D10)
- [x] 4.5 Strip the `model · agent · status` block from `ChatHeader` and add the overflow (`⋯`) trigger that opens the session context menu for the active session
- [x] 4.6 Add the Clear action to `ChatSessionMenu` beside Delete, so one menu component serves both the right-click and overflow entry points

## 5. E2E

- [x] 5.1 Add `openSettings(page, section)` to `e2e/helpers.js` so specs reach a section through one path instead of hard-coding modal internals, and update any navigation helper that assumes the eight-tab nav
- [x] 5.2 Rewrite the ten specs coupled to removed shell selectors — `app`, `nav-persistence`, `settings-menu`, `i18n`, `model-selection`, `llm-models`, `dashboard`, `chat-polish`, `composer-stop`, `live` — re-pointing selectors while preserving every original assertion; new behavior belongs in 5.3 and 5.4, not smuggled into a rewrite
- [x] 5.3 Add `settings-modal.spec.js`: opening from the gear and the shortcut, deep-linking to a section, switching sections and the resulting URL and back-button behavior, Escape and backdrop dismissal restoring the background URL, `/settings` and unknown-slug fallback, and all seven legacy redirects
- [x] 5.4 Add `theme.spec.js`: three-way switching, persistence across reload, system following `prefers-color-scheme` live, no flash of the wrong theme on first paint with a stored choice, and code blocks switching with the theme
- [x] 5.5 Confirm the fourteen URL-driven specs still pass unmodified — if one needed an edit, a legacy route is 404ing instead of redirecting, which is a bug in task 3.9 rather than a reason to edit the spec
- [x] 5.6 Run the full suite and compare against the task 1.1 baseline; every delta must be explained as either a fix or a known pre-existing flake

## 6. Verification

- [x] 6.1 Run `npm run web:build` and confirm it passes, including the `check-locales` guard
- [x] 6.2 Start the app with `npm start` and walk every nav surface and every Settings section in both light and dark mode, checking legibility and interactive states — type checks and e2e verify code correctness, not visual correctness
- [x] 6.3 Verify the four collapsed model entry points now read as two with distinct jobs: the ControlStrip changes the model for a turn, Settings → Models configures providers and the default; no third surface shows or changes the model
- [x] 6.4 Run `openspec validate redesign-app-shell --strict` and confirm the implementation matches the delta specs
