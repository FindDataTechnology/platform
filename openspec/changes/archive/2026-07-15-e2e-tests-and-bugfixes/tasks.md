# Tasks

## 1. Dependencies & scripts

- [x] 1.1 Add `@playwright/test` (devDependency) and `undici` (dependency) to `package.json` and run `npm install`
- [x] 1.2 Add `test:e2e` (fast/default project) and `test:e2e:smoke` (includes `@smoke` chat-turn project) scripts to `package.json`
- [x] 1.3 Install browser binaries: `npx playwright install chromium` (route through `http_proxy=http://127.0.0.1:7892` if the download is blocked)

## 2. Test-isolation config (env-overridable store dirs)

- [x] 2.1 In `chat-history.js`, resolve `STORE_DIR` from `process.env.CHAT_HISTORY_STORE_DIR` when set, falling back to `path.resolve("chat-history-store")`
- [x] 2.2 In `documents.js`, resolve `STORE_DIR` from `process.env.DOCUMENTS_STORE_DIR` when set, falling back to `path.resolve("documents-store")`
- [x] 2.3 Verify production behavior is unchanged when the env vars are unset (server still writes to the existing dirs)

## 3. Duplicate assistant-text broadcast fix

- [x] 3.1 In `server.js`, add a per-turn `streamedTextThisTurn` flag: set `true` on the first `text_delta` in `message_update`, reset to `false` on `agent_start`
- [x] 3.2 Remove the full-text `broadcast({ type: "text", delta: block.text })` loop from the `message_end` handler (streaming already delivered it)
- [x] 3.3 In the `agent_end` handler, keep chat-history persistence unchanged, but broadcast the final assistant text only when `!streamedTextThisTurn` (fallback for non-streaming models)
- [x] 3.4 Manually verify a real chat turn renders the assistant text exactly once (no triplication); confirm history still saves the assistant message

## 4. URL ingestion proxy support

- [x] 4.1 In `documents.js` `fetchUrlAsText`, when `process.env.https_proxy` or `process.env.http_proxy` is set, construct `new ProxyAgent(proxyUrl)` (from `undici`) and pass it as `fetch`'s `dispatcher`
- [x] 4.2 Ensure `isPrivateHost` SSRF check still runs on the target host before fetching, regardless of proxy
- [x] 4.3 Manually verify a URL upload transitions to `ready` through the proxy (and still fails clearly for private hosts)

## 5. Playwright harness

- [x] 5.1 Create `playwright.config.js` with a `webServer` that launches `node server.js` using `PORT` from `E2E_PORT` (default 3100), `HOST=127.0.0.1`, and temp `CHAT_HISTORY_STORE_DIR`/`DOCUMENTS_STORE_DIR`, waiting for the `Platform running at` stdout line
- [x] 5.2 Define two projects: the default fast project (no LLM) and a `@smoke` project matching the `@smoke` tag for the chat-turn test
- [x] 5.3 Add `e2e/helpers.js` with temp store-dir creation (under `os.tmpdir()`) and cleanup, plus the shared base URL helper

## 6. E2E tests

- [x] 6.1 App loads and sidebar navigation switches between Chat / History / Documents views
- [x] 6.2 Submitting text content adds a document that transitions to `ready`
- [x] 6.3 Uploading a `.md` file via the file input adds a document that transitions to `ready`
- [x] 6.4 Viewing a ready document shows its extracted content; removing it removes the row
- [x] 6.5 Chat History: New chat creates a current session in the list; opening a session renders its messages
- [x] 6.6 `@smoke` chat turn: send a prompt, wait for `done`, assert the assistant bubble text is not duplicated, then assert the session in history has the user message and a non-empty assistant message
- [x] 6.7 Fix document-list fetch race in `app.js`: serialize `fetchDocumentList` so a stale in-flight response cannot clobber a newer one and leave a row stuck on `indexing` (found while stabilizing the documents E2E test)

## 7. Verification & docs

- [x] 7.1 Run `npm run test:e2e` and confirm the fast suite is green
- [x] 7.2 Run `npm run test:e2e:smoke` and confirm the full suite (including chat turn) is green
- [x] 7.3 Add a short `e2e/README.md` noting the run commands and the proxy step for `playwright install`
- [x] 7.4 Restart the running server with the fixed code and confirm in the browser that chat history appears and document upload (text + file) succeeds
