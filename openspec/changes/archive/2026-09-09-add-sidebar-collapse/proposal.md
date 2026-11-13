# add-sidebar-collapse

## Why

The 240px navigation rail is permanently pinned on desktop viewports. Users
working in a wide chat or knowledge view cannot reclaim that horizontal
space; the only sidebar-less experience today is a narrow-viewport accident.
Every comparable harness UI ships a collapse toggle next to the brand for
this.

## What Changes

- Desktop (md+) gains a collapse toggle in the sidebar header row (next to
  the brand), collapsing the rail entirely so the content column takes the
  full width; a compact re-expand affordance remains reachable (pinned
  button at the top-left of the content area) and a keyboard shortcut
  (Ctrl/Cmd+B) toggles in both directions.
- The collapsed state persists per browser (localStorage) and is restored
  on load.
- Below-md behavior is unchanged: the off-canvas drawer with its backdrop
  stays exactly as it is (its toggle lives in the chat header).
- No nav content, tab set, or routing changes.

## Capabilities

### New Capabilities

<!-- none — this change only modifies app-navigation behavior -->

### Modified Capabilities
- `app-navigation`: the desktop shell gains a collapsible rail (toggle,
  restore affordance, shortcut, persistence) while the tab set and
  below-md drawer behavior stay as specified.

## Impact

- `web/src/App.tsx`: layout condition for the rail + restore affordance.
- `web/src/components/Sidebar.tsx`: header row with the collapse toggle.
- i18n: toggle labels in five locales; no server or WS changes.
