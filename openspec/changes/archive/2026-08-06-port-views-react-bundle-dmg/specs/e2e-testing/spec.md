## MODIFIED Requirements

### Requirement: E2E suite launches an isolated server and drives the React UI

The project SHALL provide a Playwright-based end-to-end test suite that launches the server fresh via a `webServer` config on an overridable test port (default 3100) bound to `127.0.0.1`, using throwaway store directories passed through `CHAT_HISTORY_STORE_DIR` and `DOCUMENTS_STORE_DIR` env vars so the user's real `chat-history-store/` and `documents-store/` are never touched. The suite SHALL drive the real browser UI (Chromium) against the React SPA routes (`/chat`, `/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`). Element selection SHALL use `[data-testid=...]` attributes, not CSS classes or text content, so tests survive styling changes.

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

### Requirement: E2E suite covers document management flows on the React Documents view

The suite SHALL cover (on the React `/documents` route) adding a text document and a markdown file upload, asserting each transitions to `ready`; listing documents; viewing a document's extracted content; deleting a document; creating a collection; adding a document to a collection; and querying a collection. These flows SHALL NOT require an LLM call (use a stubbed/no-network provider config where possible).

#### Scenario: text document uploads and becomes ready
- **WHEN** the test submits text content through the React Documents view
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: markdown file uploads and becomes ready
- **WHEN** the test uploads a `.md` file through the React file input
- **THEN** a document row SHALL appear and its status badge SHALL become `ready`

#### Scenario: document content is viewable and deletable
- **WHEN** the test clicks View on a ready document
- **THEN** the extracted content SHALL be displayed
- **WHEN** the test clicks Remove on a document
- **THEN** the row SHALL disappear from the list

#### Scenario: collection create, add document, query
- **WHEN** the test creates a collection, adds a ready document to it, and submits a query
- **THEN** the collection SHALL list the document
- **AND** the query SHALL return an answer sourced from that document

### Requirement: E2E suite covers chat history flows on the React Chat History view

The suite SHALL cover (on the React `/history` route) starting a new chat session, asserting it appears in the session list, and viewing a session's messages read-only.

#### Scenario: new session appears in history
- **WHEN** the test clicks the New chat control in the Chat History view
- **THEN** a new session SHALL appear in the session list
- **AND** SHALL be marked as the current session

#### Scenario: session messages are viewable
- **WHEN** the test opens a session in the Chat History view
- **THEN** the session's messages SHALL render in order, read-only

## ADDED Requirements

### Requirement: E2E suite covers the React Dashboard view

The suite SHALL cover the React `/dashboard` route: it loads, fetches `/api/supervisor/status`, renders a row per server, shows the current model, and shows document/collection counts. It SHALL assert no secret fields appear in the response.

#### Scenario: Dashboard renders server rows
- **WHEN** the test navigates to `/dashboard`
- **THEN** a row SHALL render for each known server id (at least `server-js`)
- **AND** the current model SHALL be displayed

#### Scenario: Dashboard response contains no secrets
- **WHEN** the test intercepts the `/api/supervisor/status` response
- **THEN** the JSON SHALL NOT contain `VOLCES_API_KEY`, `LITELLM_API_KEY`, `OPENCONNECTOR_RUNTIME_TOKEN`, or `OPENCONNECTOR_ADMIN_TOKEN`

### Requirement: E2E suite covers embedded service views

The suite SHALL cover the React `/openconnector` and `/litellm` routes: when the service is enabled, the view renders an iframe; when disabled, it renders the placeholder. The test MAY stub `/api/config` to force enabled/disabled states.

#### Scenario: OpenConnector view renders iframe when enabled
- **WHEN** the test stubs `/api/config` with `openconnectorEnabled: true` and navigates to `/openconnector`
- **THEN** an `<iframe>` SHALL be present in the DOM

#### Scenario: OpenConnector view shows placeholder when disabled
- **WHEN** the test stubs `/api/config` with `openconnectorEnabled: false` and navigates to `/openconnector`
- **THEN** the view SHALL render a not-configured placeholder
- **AND** no `<iframe>` SHALL be present

### Requirement: E2E suite verifies in-app navigation preserves the WebSocket

The suite SHALL verify that navigating between React views via the sidebar does not reload the page and does not drop the WebSocket connection.

#### Scenario: Navigation keeps WebSocket open
- **WHEN** the test loads `/chat`, observes a connected WebSocket, then clicks the Documents sidebar link, then clicks Chat
- **THEN** the page SHALL NOT have reloaded (no new document load event for the shell)
- **AND** the WebSocket SHALL remain in the same connected state throughout
