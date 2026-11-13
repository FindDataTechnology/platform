## Context

The React SPA under `web/` has accumulated eight sidebar nav entries, a Settings popover, a six-control sidebar footer, a ChatHeader status strip, and a ControlStrip — with no rule separating "product surface" from "operator configuration". The model control alone is reachable four ways. The palette in `web/src/styles/globals.css` is already fully tokenized with semantic oklch variables in shadcn naming, and its own header comment anticipates light mode as "a one-file change"; nothing has forced the issue until now.

Constraints that shape the design:

- **No backend involvement.** Every change is inside `web/src/` and `e2e/`. `server.js` serves `web/dist/` with a SPA fallback, so any new client route resolves without a server change.
- **Deep links must keep working.** Fourteen of the twenty-four e2e specs navigate by `page.goto('/mcp')` and friends, and users have bookmarks. Every legacy route has to resolve, not 404.
- **Page components are reused, not rewritten.** `ModelsPage`, `ExtensionsPage`, and `DashboardPage` move into a new container. Their internals, their `data-testid`s, and their REST calls stay as they are — otherwise this change balloons past what one reviewer can hold.
- **i18n is enforced.** A `check-locales` build guard fails the build on a missing key, so every new string needs entries in all five bundles (`en`, `zh-CN`, `es`, `fr`, `ja`).
- **Tailwind v4.** Theming has to work with `@theme` and the `var(--color-*)` indirection Tailwind v4 generates, including its `color-mix()`-based opacity modifiers.

## Goals / Non-Goals

**Goals:**

- One predictable rule for placement: **work surfaces are nav tabs; configuration is a Settings section.**
- Exactly one place to change each runtime control for a turn (the ControlStrip) and exactly one place to configure each subsystem (a Settings section).
- Light, dark, and system themes with no flash of the wrong theme on first paint, including inside code blocks.
- Legacy deep links continue to resolve, so the fourteen URL-driven e2e specs and existing bookmarks are untouched.

**Non-Goals:**

- No density / compact-mode setting. It multiplies the visual QA surface for a preference nobody has asked for; the spacing scale stays as it is.
- No redesign of the page bodies. Knowledge, Agents, Bots, Trace, Models, MCP, Skills, and System Status keep their current internals — this change moves and reframes them, it does not rewrite them.
- No custom / user-authored themes. Three fixed choices.
- No changes to the WebSocket protocol, REST contracts, or any server module.
- No new UI dependency. The modal is built from the existing shadcn-style primitives already in `web/src/components/ui/`; no dialog library is added.

## Decisions

### D1 — Nav holds work surfaces; Settings holds configuration

The nav becomes Chat, Knowledge, Agents, Bots, Trace. Everything else becomes a Settings section.

The dividing line is **"does the user come here to look at or produce content, or to change a setting and leave?"** Knowledge holds documents, Agents is a catalog the user browses (and which is slated to grow information sources), Bots is a separate catalog the user asked to keep distinct from Agents, and Trace is a log the user reads. Models, MCP, Skills, and System Status are all configure-and-leave.

System Status is the least obvious call. It went to Settings because it is four read-only status cards with a refresh button — no scroll pressure, no content — and because today it is already only reachable from the Settings popover, with no nav tab. Making it a Settings section is a rename of what it already is.

*Alternative considered:* keep all eight as nav entries and just group them under headings. Rejected because it does not reduce the number of decisions the user makes on every glance at the sidebar, and it leaves the Settings popover as a second, overlapping path to the same pages.

### D2 — Settings is a modal, routed at `/settings/:section`

The modal renders as a sibling of `<Routes>`, driven by matching the current location against `/settings/:section`. When the user opens Settings from within the app, the chat (or whatever page they were on) stays mounted underneath and Escape returns them to it with scroll position intact. React Router's background-location pattern carries the underlying route in `location.state.backgroundLocation`.

A direct load of `/settings/models` has no background location. Rather than special-casing an empty backdrop, the modal falls back to rendering `/chat` underneath. This is the same resolution the app already applies to `/` and to unmatched paths, so it needs no new concept.

*Alternative considered:* keep configuration as full pages under a `/settings` layout route. Rejected because it does not fix the core complaint — you leave your chat to change a model and have to navigate back. The modal is what every comparable product does, and `Cmd/Ctrl + ,` is the universal affordance for it.

*Alternative considered:* a modal with local state and no URL. Rejected because it breaks deep-linking, which is what lets the legacy routes redirect cleanly and what keeps the e2e suite able to `goto` a section directly.

### D3 — Legacy routes redirect into Settings sections

| Legacy | Redirects to |
|---|---|
| `/models` | `/settings/models` |
| `/mcp`, `/extensions`, `/extensions/mcp` | `/settings/mcp` |
| `/skills`, `/extensions/skills` | `/settings/skills` |
| `/dashboard` | `/settings/status` |

Redirects, not aliases: one canonical URL per section keeps the section registry the single source of truth and prevents two URLs from rendering the same pane. `/documents` → `/knowledge` already works this way in `App.tsx`, so this follows an established pattern in the file.

### D4 — Theming uses native CSS `light-dark()`, not duplicated token blocks

The proposal described splitting `@theme` into two selector blocks. On implementation review, CSS's `light-dark()` function does the same job with one declaration per token instead of two blocks that must be kept in sync:

```css
:root { color-scheme: light dark; }
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"]  { color-scheme: dark; }

@theme {
  --color-background: light-dark(oklch(0.99 0 0), oklch(0.16 0 0));
  /* … one line per token, dark value unchanged from today … */
}
```

`color-scheme: light dark` on `:root` with no `data-theme` attribute makes the system preference the default **with zero JavaScript**, which also means the system case cannot flash. Only an explicit override needs `data-theme` set before first paint, handled by a three-line inline script in `index.html` reading `localStorage`. `color-scheme` additionally fixes native form controls and scrollbars for free, which a manual token swap would not.

`light-dark()` is Baseline (Chrome 123 / Safari 17.5 / Firefox 120) and the packaged Electron ships a newer Chromium, so support is not a concern for the desktop build.

*Risk this carries:* Tailwind v4's opacity modifiers (`bg-card/95`, used in ChatHeader today) compile to `color-mix(in oklab, var(--color-card) 95%, transparent)`. `color-mix()` with a `light-dark()` operand is spec-valid but is the one part of this that has to be verified rather than assumed — hence a dedicated spike task before the palette is converted. If it fails, the fallback is the duplicated-block approach the proposal originally described: mechanical, more lines, no behavioral difference.

### D5 — Shiki renders both themes at once; CSS picks

`Markdown.tsx` currently builds a singleton highlighter with the single theme `github-dark-dimmed`. Rather than tearing down and rebuilding the highlighter on every theme change — which would re-highlight every code block on screen and require the theme to be threaded into the lazy-loading singleton — the highlighter registers both `github-dark-dimmed` and `github-light`, and renders with Shiki's dual-theme mode (`themes: { light, dark }`, `defaultColor: false`). Shiki then emits `--shiki-light` / `--shiki-dark` custom properties per token, and a small CSS rule keyed off the same `light-dark()` mechanism as everything else selects which one applies.

This makes theme switching in code blocks free at runtime — no re-render, no re-highlight, no async work — at the cost of one extra theme in the bundle and slightly larger highlighted HTML. Given the highlighter is already lazy-loaded on first code block, that trade is clearly worth it.

### D6 — ControlStrip owns runtime state; Settings owns configuration

The split is **per-turn versus persistent**: which model answers *this* turn is a ControlStrip control; which providers exist and what the default is, is Settings → Models. The agent selector moves from the sidebar footer to the ControlStrip because it is per-turn by that definition.

This makes the four current model entry points collapse to two with distinct jobs, and it means the sidebar footer and ChatHeader no longer need to report model or agent at all — the ControlStrip is on screen whenever a turn can be sent.

One consequence to respect, with one caveat. The ControlStrip's existing discipline is that a control renders what the runtime **is**, never what was requested, because a workspace/model/effort change restarts the dsh child process. The agent control adopts the no-optimistic-state half of that rule — it reflects `currentAgent` from the store and is rejected while streaming — but **not** the restart half: `switchAgentTo` in `server/agent-session.js` flips `ctx.currentAgentId` and broadcasts `agent_changed` synchronously, with no child restart. So the agent control is the one control in the strip that shows no pending spinner. Specifying otherwise would have mandated a restart that serves no purpose.

### D7 — Clear-chat moves into the existing session context menu

"Clear chat" is a destructive action that currently sits as a permanent button in the sidebar footer. `ChatSessionMenu.tsx` already exists as the right-click menu on session rows and already owns delete. Clear belongs next to delete, and the ChatHeader `⋯` overflow opens the same menu component for the active session — so there is one menu, two triggers, no new component.

### D8 — E2E: rewrite the ten coupled specs, add two, leave fourteen alone

The suite splits cleanly. Fourteen specs navigate by URL and assert on page-body `data-testid`s that this change does not touch; because every legacy route redirects rather than 404s, they keep passing without edits. Ten specs reach for shell selectors that are being removed (`nav-*` for the demoted tabs, `settings-menu*`, `model-chip`, `agent-select`, `clear-btn`, `locale-select`, `chat-header-model`/`-agent`/`-status-dot`) and need rewriting against the new ones.

`helpers.js` gains an `openSettings(page, section)` helper so the ten rewrites and the new specs share one path to a section instead of each hard-coding the modal's internals. Two new specs cover what did not exist before: the settings modal (open, deep-link, section switching, Escape, backdrop, `Cmd/Ctrl + ,`, legacy redirects) and theming (three-way switch, persistence across reload, system follow, no flash, code-block sync).

The order matters for a reviewable diff: the helper lands first, then the shell changes with their spec rewrites, then the new specs. A full suite run gates the change as done.

## Risks / Trade-offs

- **`color-mix()` over `light-dark()` may not compile as expected in Tailwind v4's opacity modifiers** → Spike it on one component before converting the palette (Task 4.1). Fallback is the duplicated `[data-theme]` block approach, which is mechanical and carries no behavioral difference.

- **Light mode will expose contrast bugs that dark mode hid.** Components with hardcoded `bg-black/60` (the mobile drawer backdrop), opacity-based hover states, and borders tuned against near-black surfaces will look wrong on white → Grep for literal color classes as an explicit task rather than discovering them page by page, and walk all five nav surfaces plus all five Settings sections in light mode before calling it done.

- **The modal-over-background-location pattern can double-render heavy pages.** Opening Settings from Trace keeps Trace mounted; if a Settings section is also heavy, both are live at once → Settings sections stay lazy-loaded, same as the pages are today, so only the open section mounts.

- **Ten spec rewrites can quietly lose coverage.** A rewrite is an opportunity to drop an assertion that was load-bearing → Each rewrite preserves its original assertions and only re-points the selectors; new behavior goes in the two new specs, not smuggled into rewrites.

- **Some e2e specs are known-flaky independent of this change** (the "invalid model id shows error" case in `model-selection.spec.js` flakes on the current build too) → Establish a baseline run on `main` before the shell changes land, so a flake is not misread as a regression.

- **`/settings` collides with nothing today, but the section slugs are now public API.** Changing `status` to `dashboard` later would break bookmarks a second time → Fix the five slugs in the spec (`general`, `models`, `mcp`, `skills`, `status`) and treat them as stable.

## Migration Plan

There is no data migration, no server change, and no persisted format change beyond one new `localStorage` key for the theme (absent = system, which is the intended default).

Sequencing within the change, chosen so the app is never in a half-shell state on any commit:

1. **Theme foundation** (spike → tokens → hook → Shiki). Isolated from the layout work; the app looks identical in dark mode when this lands.
2. **Settings modal** with its five sections and legacy redirects, mounted alongside the existing nav. Both paths work at this point — this is the only deliberately redundant step, and it exists so the modal can be verified before anything is deleted.
3. **Shell reduction**: nav to five entries, footer to one row, ChatHeader stripped, ControlStrip gains the agent control, `SettingsMenu.tsx` deleted.
4. **E2E**: helper, ten rewrites, two new specs, full suite run.

Rollback is a revert; nothing outside `web/` and `e2e/` is touched, and the one new `localStorage` key is ignored by the old code.

## Open Questions

None outstanding. Two questions were open at proposal time and are now decided:

### D9 — Legacy redirects are silent

No "Models moved to Settings" toast. The redesign lands during development, not in front of a user base with muscle memory for the old nav, so the notice would be throwaway code written for a transition nobody experiences. The redirects themselves are permanent, which is the part that actually matters for bookmarks.

### D10 — The agent control renders only when there is something to switch between

The ControlStrip shows the agent control when two or more switchable agents exist, and omits it otherwise. The catalog is optional — `agents.json` is gitignored and `AGENTS_CONFIG_URL` is unset by default — so the common deployment has exactly one agent, and a fifth control reading "Local" that cannot do anything is noise in a strip that already carries four.

The objection to hiding is layout shift: the agent list arrives asynchronously via `list_agents`, so the control would pop in after connect. That is acceptable because it is the same startup-time settle the model control already has when its list populates, it happens before the user has reason to touch the strip, and it only occurs in deployments that *do* have a catalog — where the control is wanted. A control that permanently occupies space to display a single unchangeable value is the worse trade.

