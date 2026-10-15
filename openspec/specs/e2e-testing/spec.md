# e2e-testing Specification

## Purpose
TBD - created by archiving change e2e-tests-and-bugfixes. Update Purpose after archive.
## Requirements
### Requirement: E2E suite launches an isolated server and drives the browser UI
The project SHALL provide a Playwright-based end-to-end test suite that launches the server fresh via a `webServer` config on an overridable test port (default 3100) bound to `127.0.0.1`, using throwaway store directories passed through `CHAT_HISTORY_STORE_DIR` and `DOCUMENTS_STORE_DIR` env vars so the user's real `chat-history-store/` and `documents-store/` are never touched. The suite SHALL drive the real browser UI (Chromium). The store directories SHALL default to their current hard-coded paths when the env vars are unset, so production behavior is unchanged.

#### Scenario: server boots fresh for the test run
- **WHEN** the test suite starts
- **THEN** Playwright SHALL launch `node server.js` with the test port and temp store-dir env vars
- **AND** SHALL wait for the server-ready stdout line before running tests
- **AND** SHALL tear the server down after the suite finishes

#### Scenario: test state is isolated from real data
- **WHEN** a test writes a document or chat session
- **THEN** the write SHALL land in the throwaway temp store directory
- **AND** SHALL NOT create or modify files under the project's real `chat-history-store/` or `documents-store/`

#### Scenario: store dirs default to current paths without env
- **WHEN** the server starts without `CHAT_HISTORY_STORE_DIR` or `DOCUMENTS_STORE_DIR` set
- **THEN** the modules SHALL use `chat-history-store/` and `documents-store/` exactly as before

### Requirement: E2E suite covers document management flows
The suite SHALL cover adding a text document and a markdown file upload, asserting each transitions to `ready`; listing documents; viewing a document's extracted content; and deleting a document (asserting it is removed). These flows SHALL NOT require an LLM call.

#### Scenario: text document uploads and becomes ready
- **WHEN** the test submits text content through the Documents tab
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: markdown file uploads and becomes ready
- **WHEN** the test uploads a `.md` file through the file input
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: document content is viewable and deletable
- **WHEN** the test clicks View on a ready document
- **THEN** the extracted content SHALL be displayed
- **WHEN** the test clicks Remove on a document
- **THEN** the row SHALL disappear from the list

### Requirement: E2E suite covers chat history flows
The suite SHALL cover starting a new chat session from the Chat History tab, asserting it appears in the session list, and viewing a session's messages read-only.

#### Scenario: new session appears in history
- **WHEN** the test clicks the New chat button in the Chat History tab
- **THEN** a new session SHALL appear in the session list
- **AND** SHALL be marked as the current session

#### Scenario: session messages are viewable
- **WHEN** the test opens a session in the Chat History tab
- **THEN** the session's messages SHALL render in order, read-only

### Requirement: E2E suite verifies a real chat turn saves history without duplicate text
The suite SHALL include a chat-turn test (isolated as a separate `@smoke` Playwright project) that sends one prompt, waits for the turn to complete, and asserts both that the rendered assistant text is not duplicated and that the resulting chat-history session contains the user message and the assistant reply.

#### Scenario: assistant text renders exactly once
- **WHEN** the test sends a prompt and the agent turn completes
- **THEN** the assistant bubble SHALL contain the response text exactly once (not repeated)

#### Scenario: chat turn is persisted to history
- **WHEN** the agent turn completes
- **THEN** the current chat-history session SHALL contain the user message and a non-empty assistant message

### Requirement: A single command runs the E2E suite
The project SHALL provide an `npm run test:e2e` script that runs the offline deterministic Playwright `fast` project, an `npm run test:e2e:smoke` script that runs ONLY the `@smoke`-tagged chat-turn project (real LLM calls, requires local secrets), and `test:e2e:live`/`test:e2e:live:smoke` scripts for the remote live service. No script other than the explicit `live` scripts SHALL select the `live` Playwright project. Browser binaries SHALL be installable via `npx playwright install chromium`.

#### Scenario: run the fast suite
- **WHEN** a developer runs `npm run test:e2e`
- **THEN** the deterministic, no-LLM tests SHALL run against a freshly launched server

#### Scenario: run the smoke subset only
- **WHEN** a developer runs `npm run test:e2e:smoke`
- **THEN** only the `@smoke`-tagged tests SHALL be selected
- **AND** the `live` project tests SHALL NOT run and no request SHALL be made to the remote live service

#### Scenario: live suite stays opt-in
- **WHEN** a developer runs `npm run test:e2e` or `npm run test:e2e:smoke` without `PW_LIVE=1`
- **THEN** no test SHALL contact the deployed live service URL

### Requirement: E2E suite covers model switching flow
The suite SHALL cover switching models via the UI selector and via the `/model` chat command, asserting the `model_changed` event is broadcast, the selector updates, and an error is shown for invalid model ids.

#### Scenario: model selector loads models and reflects active model
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be populated with available models
- **AND** SHALL reflect the currently active model sent in `current_model`

#### Scenario: switch model via UI selector
- **WHEN** the test selects a different model from the dropdown
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** the selector SHALL be updated to show the new active model

#### Scenario: switch model via /model command
- **WHEN** the test sends `/model <id>` through the chat input
- **THEN** the server SHALL broadcast `model_changed` with the new id
- **AND** a command use event SHALL be shown confirming the switch

#### Scenario: invalid model id shows error
- **WHEN** the test sends `/model nonexistent-model-id`
- **THEN** an error event SHALL be shown
- **AND** the active model SHALL remain unchanged

### Requirement: E2E suite covers document chat (RAG) flow
The suite SHALL cover the "Ask the collection" flow: adding a text document, waiting for it to be ready, querying the document collection, and verifying an answer is returned with source document names. This test SHALL be marked `@smoke` since it requires an LLM call.

#### Scenario: query document collection returns an answer
- **WHEN** the test adds a text document with known content, waits for it to be ready, and submits a query through the "Ask the collection" input
- **THEN** an answer SHALL be displayed in the answer area
- **AND** the answer SHALL reference the source document name

#### Scenario: empty collection query returns empty answer
- **WHEN** the test queries the collection with no ready documents
- **THEN** an empty or placeholder answer SHALL be shown
- **AND** no source document names SHALL be listed

### Requirement: E2E suite covers thinking block keyboard shortcut
The E2E suite SHALL test that thinking blocks are displayed when the agent produces reasoning output, and that the `Ctrl+O` keyboard shortcut toggles their visibility.

#### Scenario: Thinking block appears when agent produces reasoning
- **WHEN** the agent sends a `thinking` event during a turn
- **THEN** a thinking block SHALL appear in the chat
- **AND** the block SHALL be expanded by default

#### Scenario: Ctrl+O toggles thinking block state
- **GIVEN** a thinking block is present and expanded in the chat
- **WHEN** the test presses `Ctrl+O`
- **THEN** the thinking block SHALL collapse
- **WHEN** the test presses `Ctrl+O` again
- **THEN** the thinking block SHALL expand

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

### Requirement: E2E suite verifies SQLite persistence
The suite SHALL verify document metadata and preferences are persisted to SQLite and survive server restart.

#### Scenario: document list is served from SQLite database
- **WHEN** a document is created
- **THEN** it SHALL appear in the document list
- **AND** the document SHALL persist in the SQLite database

#### Scenario: preferences round-trip through the API
- **WHEN** a preference is saved
- **THEN** the same value SHALL be returned when queried

### Requirement: E2E suite covers collections functionality
The suite SHALL verify collections can be created, documents added to collections, and collections can be listed and deleted.

#### Scenario: collections CRUD operations
- **WHEN** a collection is created
- **THEN** it SHALL appear in the collections list
- **WHEN** a document is added to a collection
- **THEN** the document SHALL be listed under that collection
- **WHEN** a document is removed from a collection
- **THEN** the document SHALL NOT appear under that collection
- **WHEN** a collection is deleted
- **THEN** it SHALL NOT appear in the collections list

### Requirement: E2E suite covers documents collection save flow
The suite SHALL cover creating a collection, adding documents to it, saving the collection, and asserting the collection persists with the correct document count.

#### Scenario: create and save a document collection
- **WHEN** the test creates a collection, adds documents, and clicks Save
- **THEN** the collection SHALL appear in the collections list
- **AND** SHALL have the correct document count

### Requirement: E2E suite covers model selector click and switch flow
The suite SHALL cover clicking the model selector, asserting the dropdown opens without errors, selecting a different model, and asserting the model changes.

#### Scenario: model selector click works without error
- **WHEN** the test clicks on the model selector input
- **THEN** no JavaScript error SHALL be thrown
- **AND** the model dropdown SHALL be visible

#### Scenario: model switch via selector
- **WHEN** the test selects a different model from the dropdown
- **THEN** the `model_changed` event SHALL be received
- **AND** the selector SHALL display the new model id

### Requirement: E2E suite covers basic chat prompt submission flow
The suite SHALL cover typing a prompt, clicking send, and asserting the message is sent without JavaScript errors.

#### Scenario: chat prompt submission works without error
- **WHEN** the test types a prompt and clicks Send
- **THEN** the user message SHALL appear in the chat
- **AND** no JavaScript error SHALL be thrown
- **AND** the input SHALL be disabled during streaming

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

