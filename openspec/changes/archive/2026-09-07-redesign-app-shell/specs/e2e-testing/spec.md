## ADDED Requirements

### Requirement: E2E suite provides a shared Settings navigation helper

`e2e/helpers.js` SHALL export an `openSettings(page, section)` helper that opens the Settings modal and activates the named section, resolving when that section's pane is visible. Specs that need to reach a Settings section SHALL use this helper rather than hard-coding the modal's trigger, backdrop, or section-list internals, so a change to the modal's structure is absorbed in one place.

The helper SHALL accept the canonical section slugs `general`, `models`, `mcp`, `skills`, and `status`.

#### Scenario: helper opens the modal at a named section

- **WHEN** a spec calls `openSettings(page, "mcp")`
- **THEN** the Settings modal SHALL be open
- **AND** the MCP pane SHALL be visible
- **AND** the URL SHALL be `/settings/mcp`

#### Scenario: specs reach Settings only through the helper

- **WHEN** a spec whose subject is NOT the Settings modal itself navigates to a Settings section
- **THEN** it SHALL go through `openSettings` rather than selecting the modal's trigger, backdrop, or section-list elements directly
- **AND** the specs that own the modal's own behavior — its open affordances, dismissal paths, and section switching — SHALL drive those elements directly, because that behavior is what they exist to assert

### Requirement: E2E suite covers the Settings modal

The suite SHALL include a spec covering the Settings modal's own behavior, in the deterministic no-LLM `fast` Playwright project: opening it from the sidebar gear and via the `Cmd/Ctrl + ,` shortcut; deep-linking directly to `/settings/:section`; switching between sections; dismissing with Escape and with a backdrop click; and each legacy route redirecting to its Settings section.

#### Scenario: modal opens from the gear and from the keyboard shortcut

- **WHEN** the test clicks the sidebar gear
- **THEN** the Settings modal SHALL open
- **WHEN** the test dismisses it and presses `Cmd/Ctrl + ,`
- **THEN** the Settings modal SHALL open again

#### Scenario: deep link opens the modal at the requested section

- **WHEN** the test navigates directly to `/settings/models` on a fresh page load
- **THEN** the Settings modal SHALL be open with the Models pane visible
- **AND** a backdrop page SHALL be rendered beneath it rather than an empty background

#### Scenario: switching sections updates the URL without closing the modal

- **WHEN** the test opens the modal at one section and selects a different section
- **THEN** the newly selected pane SHALL become visible
- **AND** the URL's section segment SHALL update to the new section
- **AND** the modal SHALL remain open throughout

#### Scenario: Escape and backdrop click dismiss the modal

- **WHEN** the test opens the modal from the chat surface and presses Escape
- **THEN** the modal SHALL close and the chat surface SHALL be visible
- **WHEN** the test opens the modal again and clicks the backdrop
- **THEN** the modal SHALL close

#### Scenario: legacy routes redirect into Settings sections

- **WHEN** the test navigates to `/models`, `/mcp`, `/skills`, `/extensions`, `/extensions/mcp`, `/extensions/skills`, or `/dashboard`
- **THEN** each SHALL redirect to its canonical `/settings/*` URL
- **AND** the Settings modal SHALL open with the corresponding pane visible
- **AND** no navigation SHALL produce a 404 or an unmatched-route fallback

### Requirement: E2E suite covers theme switching

The suite SHALL include a spec covering theme selection, in the deterministic no-LLM `fast` Playwright project: choosing each of light, dark, and system from Settings → General; the choice surviving a page reload; the system option following the emulated OS colour-scheme preference; no flash of the wrong theme on first paint; and code blocks rendering in the active theme.

#### Scenario: each theme choice applies

- **WHEN** the test selects light, then dark, then system in Settings → General
- **THEN** the document SHALL reflect the selected theme after each choice

#### Scenario: theme choice survives a reload

- **WHEN** the test selects a non-default theme and reloads the page
- **THEN** the same theme SHALL still be active after the reload

#### Scenario: system option follows the OS preference

- **WHEN** the theme is set to system and the test emulates a light OS colour-scheme preference
- **THEN** the light palette SHALL be active
- **WHEN** the test emulates a dark OS colour-scheme preference
- **THEN** the dark palette SHALL be active

#### Scenario: no flash of the wrong theme on first paint

- **WHEN** an explicit theme is stored and the page is loaded fresh
- **THEN** the correct theme SHALL be applied before first paint
- **AND** no frame SHALL render with the opposite palette

#### Scenario: code blocks follow the active theme

- **WHEN** a highlighted code block is on screen and the theme is switched
- **THEN** the code block SHALL render in the newly active theme
- **AND** the switch SHALL NOT require a re-highlight or a page reload

### Requirement: Shell selector migration preserves existing coverage

The specs that reference shell selectors removed by this change — `app`, `nav-persistence`, `settings-menu`, `i18n`, `model-selection`, `llm-models`, `dashboard`, `chat-polish`, `composer-stop`, and `live` — SHALL be re-pointed at the new selectors while preserving every assertion they made before the change. A rewrite SHALL NOT drop, weaken, or silently skip an assertion; behavior that is genuinely new SHALL be covered by the new Settings-modal and theming specs instead of being folded into a rewrite.

The remaining specs navigate by URL and SHALL continue to pass unmodified, because every legacy route redirects rather than 404s. A baseline suite run SHALL be recorded before the shell changes land, so a pre-existing flake is not misread as a regression introduced by this change.

#### Scenario: rewritten specs keep their original assertions

- **WHEN** a spec that referenced a removed shell selector is rewritten
- **THEN** every assertion it previously made SHALL still be made
- **AND** only the selectors used to reach the asserted state SHALL have changed

#### Scenario: URL-driven specs are untouched and still pass

- **WHEN** the full suite is run after the shell changes land
- **THEN** the specs that navigate by URL SHALL pass without having been modified

#### Scenario: a baseline distinguishes flakes from regressions

- **WHEN** a spec fails after the shell changes land
- **THEN** its result SHALL be comparable against the recorded pre-change baseline run
- **AND** a failure present in the baseline SHALL NOT be attributed to this change

## MODIFIED Requirements

### Requirement: E2E suite covers app shell navigation

The suite SHALL verify the sidebar contains exactly the canonical work-surface navigation tabs — Chat, Knowledge, Agents, Bots, and Trace — that switching between them works correctly, and that the demoted configuration entries are absent from the sidebar.

#### Scenario: sidebar shows current navigation tabs

- **WHEN** the app loads
- **THEN** the sidebar SHALL show the navigation tabs Chat, Knowledge, Agents, Bots, and Trace
- **AND** no Models, MCP Servers, Skills, Dashboard, Documents, or Extensions navigation tab SHALL be present

#### Scenario: switching between work surfaces works

- **WHEN** the test clicks each work-surface tab in turn
- **THEN** the corresponding surface SHALL render
- **AND** the active tab SHALL be highlighted

### Requirement: E2E suite covers extensions management UI flows

The suite SHALL cover the MCP and Skills Settings section management flows end-to-end through the browser, in the deterministic no-LLM `fast` Playwright project: adding an MCP server via the form and deleting it; toggling an MCP server enabled then disabled; installing an MCP server from the Store tab; opening the pre-filled form when installing from the Store; adding a custom skill and deleting it; and toggling a custom skill enabled then disabled. Each test SHALL reach its pane through the shared `openSettings(page, section)` helper rather than hard-coding the modal's internals. These tests SHALL NOT be skipped.

#### Scenario: add MCP server via form then delete

- **WHEN** the test opens the Add MCP form, fills a name and an HTTP URL, and clicks Add
- **THEN** the dialog SHALL close and a card for the new server SHALL appear in the Enabled tab
- **AND** the new card SHALL show a delete button (no "auto" badge, since it is user-added)
- **WHEN** the test clicks delete and confirms
- **THEN** the card SHALL disappear from the Enabled tab

#### Scenario: toggle MCP server enabled and disabled

- **WHEN** the test adds an MCP server and toggles it off
- **THEN** the toggle SHALL reflect the disabled state and a disabled badge SHALL appear on the card
- **WHEN** the test toggles it back on
- **THEN** the toggle SHALL reflect the enabled state and the disabled badge SHALL disappear

#### Scenario: install MCP from Store lands in Enabled

- **WHEN** the test switches to the Store tab, clicks Install on a market MCP card, fills the setup form (or confirms for a ready-to-use server), and submits
- **THEN** the Enabled tab SHALL become active and a card for the installed server SHALL appear

#### Scenario: clicking Install opens the pre-filled form

- **WHEN** the test clicks Install on a market MCP card in the Store tab
- **THEN** the Add MCP dialog SHALL open with the name field pre-filled from the catalog template
- **AND** the form SHALL be in setup mode driven by the template's configTemplate

#### Scenario: add custom skill via form then delete

- **WHEN** the test opens the Create Skill form, fills name, description, and content, and clicks Add
- **THEN** the dialog SHALL close and a card for the new skill SHALL appear in the Enabled tab
- **AND** the new card SHALL show a Custom badge and a delete button
- **WHEN** the test clicks delete and confirms
- **THEN** the skill card SHALL disappear

#### Scenario: toggle custom skill enabled and disabled

- **WHEN** the test adds a custom skill and toggles it off
- **THEN** the toggle SHALL reflect the disabled state and a disabled indicator SHALL appear on the card
- **WHEN** the test toggles it back on
- **THEN** the toggle SHALL reflect the enabled state and the disabled indicator SHALL disappear

## REMOVED Requirements

### Requirement: E2E suite covers dashboard tab

**Reason**: There is no Dashboard tab. The System Status surface it referred to is no longer a sidebar navigation entry or a standalone page — it becomes the Settings modal's `status` section, so a requirement phrased around clicking a Dashboard tab can no longer be satisfied as written.

**Migration**: Coverage moves to the new Settings-modal spec, which asserts that `/dashboard` redirects to `/settings/status` and that the System Status pane renders inside the modal. The pane's own content assertions are unchanged and are reached via `openSettings(page, "status")`.
