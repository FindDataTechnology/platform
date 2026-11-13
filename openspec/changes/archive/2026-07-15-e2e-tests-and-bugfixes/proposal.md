## Why

The chat-history and document-upload features were reported broken ("history chat is not exist", "documents can not upload success"). Investigation found the running server was a **15-hour-old stale process** that predates the `/api/chat-history/*` and `/api/documents/*` routes entirely — both returned `404 Cannot GET/POST`. After restarting with the current code, the core flows (text/markdown upload, chat-history save on a real chat turn) work. The project has **no automated tests**, so this regression went unnoticed. A second, real defect was also found: the assistant's text is broadcast to clients up to **3× per turn** (streaming `text` deltas + `message_end` + `agent_end` each emit the full text), producing duplicated chat output. This change adds a Playwright E2E suite to lock in the behavior of chat history, documents, and chat streaming, and fixes the duplicate-text defect.

## What Changes

- Add a **Playwright** E2E test suite (`@playwright/test`) that boots the server on an isolated test port with temporary store directories and drives the real browser UI.
- Make the store directories and bind address configurable via env (`PORT`/`HOST` already exist; add `CHAT_HISTORY_STORE_DIR`, `DOCUMENTS_STORE_DIR`) so tests run against throwaway state and never touch the user's real `chat-history-store/` / `documents-store/`.
- Add an `npm run test:e2e` script and a `playwright.config` that auto-launches the server via `webServer`.
- E2E coverage: app load + sidebar navigation; document upload (text + markdown file) → `ready`; document list / view-content / delete; chat-history new-session / list / view; and one real chat turn that asserts history is saved with both the user and assistant messages **and** that the assistant text is rendered exactly once (no triplication).
- **Fix duplicate assistant text broadcast** in `server.js`: stop re-emitting the full text on both `message_end` and `agent_end`; rely on streaming `text` deltas with a single final emission so each text segment reaches the client exactly once.
- **(Hardening)** Make URL document ingestion proxy-aware: when `http_proxy`/`https_proxy` is set, route the URL fetch through it (via `undici` `ProxyAgent`) so URL upload works in proxy environments where Node's bare `fetch` currently fails.
- **Fix document-list status race in `app.js`** (found while stabilizing the E2E suite): serialize `fetchDocumentList` calls so a stale in-flight response cannot overwrite a newer one and leave a document row stuck on `indexing` - which visibly looked like a failed upload.

## Capabilities

### New Capabilities
- `e2e-testing`: Playwright-based end-to-end test suite — how the server is launched in isolation, what the suite covers, and the `test:e2e` run command.
- `chat-streaming`: the contract for streaming assistant text to clients over WebSocket — text is delivered as deltas and each text segment is emitted exactly once per turn (no duplication across `message_update` / `message_end` / `agent_end`).

### Modified Capabilities
- `document-management`: add a requirement that URL ingestion honors the HTTP(S) proxy environment when direct egress is unavailable, so URL uploads do not silently fail with "fetch failed" in proxy environments.

## Impact

- **Code**: `server.js` (duplicate-text broadcast fix; env-overridable store dirs passed to the modules); `chat-history.js` and `documents.js` (accept a configurable store directory instead of the hard-coded `path.resolve("...")`); `documents.js` (`fetchUrlAsText` proxy support); `public/app.js` (serialized `fetchDocumentList` to fix the document-status race).
- **Dependencies / tooling**: adds `@playwright/test` and `undici` as dev/runtime dependencies; adds `playwright.config.ts` and an `e2e/` test directory; adds a `test:e2e` npm script. Introduces the project's first test runner (previously none).
- **APIs**: no REST/WS protocol changes; the duplicate-text fix only removes redundant `text` events, it does not change the event schema.
- **CI / local runs**: `npx playwright install chromium` is required once before the first run (browser download may need the local proxy). The chat-turn test makes one real LLM call against the configured provider and is isolated as a separate Playwright project so it can be skipped in fast runs.
- **Risk**: the duplicate-text fix must preserve single-emission for both streaming and non-streaming model responses; the suite's chat-turn test guards this.
