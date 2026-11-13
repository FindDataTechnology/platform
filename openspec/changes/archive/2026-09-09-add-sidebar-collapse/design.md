# Design — add-sidebar-collapse

## Context

`App.tsx` renders the rail as `hidden md:block w-[240px]` plus a below-md
off-canvas drawer (`navOpen` state, toggle in the chat header). The collapse
state has nowhere to live today; no other component depends on rail width.

## Goals / Non-Goals

**Goals:**
- One boolean of UI state, owned at the App shell level, persisted.

**Non-Goals:**
- No icon-only mini rail — the tabs carry labels and the session region
  (list, menus, search) has no meaningful collapsed form; maintaining a
  second narrow layout buys almost no space back. Collapse means collapsed.
- No changes to the below-md drawer or to routing.

## Decisions

### D1 — Full hide, not an icon rail
Collapsed = the rail is unmounted from the md+ layout (content column takes
`w-full`). Alternative (icon-only 48px rail) rejected above. The unmount
also stops the session-list socket-driven re-renders from laying out an
invisible region.

### D2 — State: `useState` + localStorage key `sidebar.collapsed`
Initialized lazily on first render (`localStorage.getItem`), written on
every toggle. The existing `useTheme` hook sets the precedent for
localStorage-backed shell preferences; no store/global state needed since
only `App.tsx` and `Sidebar.tsx` read it (passed down as props).

### D3 — Affordances: header toggle + pinned restore + Ctrl/Cmd+B
- Expanded: a `PanelLeftClose`-style icon button in the sidebar header row
  (brand row), matching the harness reference layout.
- Collapsed: the same `PanelLeft`-style icon appears pinned at the top-left
  of the content column (absolute, above the page content) so restoration
  never needs the keyboard.
- `Ctrl/Cmd+B` toggles both ways, registered in `App`'s existing global
  keydown effect (next to Ctrl/Cmd+O and Ctrl/Cmd+,).
`aria-expanded` on the toggle and localized labels (`sidebar.collapse` /
`sidebar.expand`) in all five locales.

### D4 — Transition without layout jank
No width animation in v1: a CSS transition on a grid/flex sibling reflow
tends to jitter the chat composer's autogrow measurement; instant collapse
is what the reference UI does. Revisit only if it feels abrupt in use.

## Risks / Trade-offs

- [First paint flashes the rail before localStorage is read] → Initialize
  the state lazily in the same render pass (function initializer), so the
  collapsed class is present from the first commit.
- [Users lose the sidebar and cannot find the restore affordance] → The
  pinned button sits exactly where the rail's edge was; Ctrl/Cmd+B is the
  convention most tools share.

## Migration Plan

None. Rollback = revert the component change; the localStorage key is inert.

## Open Questions

- None.
