## ADDED Requirements

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
The project SHALL provide an `npm run test:e2e` script that runs the Playwright suite, and an `npm run test:e2e:smoke` script that includes the `@smoke` chat-turn project. Browser binaries SHALL be installable via `npx playwright install chromium`.

#### Scenario: run the fast suite
- **WHEN** a developer runs `npm run test:e2e`
- **THEN** the deterministic, no-LLM tests SHALL run against a freshly launched server

#### Scenario: run the full suite including the chat turn
- **WHEN** a developer runs `npm run test:e2e:smoke`
- **THEN** the chat-turn `@smoke` tests SHALL also run
