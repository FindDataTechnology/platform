## 1. Shell state

- [x] 1.1 Add the `sidebar.collapsed` localStorage-backed state in `App.tsx` (lazy initializer, write-on-toggle) and verify the value survives a reload (Playwright: set, reload, assert)
- [x] 1.2 Conditionally render the md+ rail and the pinned re-expand affordance on the state, and verify the content column takes full width when collapsed (viewport-width assertion at md+)

## 2. Affordances

- [x] 2.1 Add the collapse toggle to the sidebar header row (icon + aria-expanded + localized label) and verify clicking it collapses the rail
- [x] 2.2 Add the pinned restore button at the top-left of the content column, shown only while collapsed, and verify clicking it restores the rail
- [x] 2.3 Register Ctrl/Cmd+B in App's global keydown effect and verify the rail toggles in both directions

## 3. i18n + tests

- [x] 3.1 Add `sidebar.collapse` / `sidebar.expand` labels to all five locales and verify no missing-key console warnings
- [x] 3.2 e2e: below-md drawer path unchanged (drawer opens, backdrop dismisses) and md+ collapse/restore/shortcut/persistence (verify Playwright run passes)
- [x] 3.3 Run `openspec validate add-sidebar-collapse --strict` and fix any reported issues
