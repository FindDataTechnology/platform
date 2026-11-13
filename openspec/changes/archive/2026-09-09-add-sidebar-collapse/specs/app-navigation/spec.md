## ADDED Requirements

### Requirement: The desktop navigation rail is collapsible
On md+ viewports the sidebar rail SHALL be collapsible: a toggle in the
sidebar header collapses the rail, a re-expand affordance SHALL remain
reachable while collapsed (pinned at the top of the content area), and
Ctrl/Cmd+B SHALL toggle the rail in both directions. The collapsed state
SHALL persist across reloads per browser. Navigation content (tab set,
session region, footer) is unchanged, and the below-md off-canvas drawer
SHALL behave exactly as before.

#### Scenario: collapse from the header toggle
- **WHEN** the user clicks the collapse toggle on a desktop viewport
- **THEN** the rail collapses and the content column takes the full width

#### Scenario: restore while collapsed
- **WHEN** the rail is collapsed and the user clicks the pinned re-expand
  affordance
- **THEN** the rail is restored with the same nav content

#### Scenario: keyboard toggle
- **WHEN** the user presses Ctrl/Cmd+B on a desktop viewport
- **THEN** the rail toggles between collapsed and expanded

#### Scenario: collapse persists across reloads
- **WHEN** the user collapses the rail and reloads the page on the same
  browser
- **THEN** the rail loads collapsed

#### Scenario: narrow viewport keeps the drawer
- **WHEN** the viewport is below md
- **THEN** the collapse toggle is not shown and the off-canvas drawer works
  as before
