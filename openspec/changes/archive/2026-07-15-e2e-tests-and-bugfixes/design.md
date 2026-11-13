## Context

The Platform app is a greenfield, no-build, ESM Node project with **no test runner, no transpiler, no linter**. The frontend is vanilla JS (`public/app.js` ~1000 lines) talking to an Express + WebSocket server that hosts a single shared pi agent session. Two features were reported broken; root cause was a stale server process (15 h old, predating the routes), not a logic error - the core flows work once the current code runs. However, a genuine broadcast defect was uncovered during investigation: a 9-character assistant reply ("ping-pong") arrived at the client as **27 characters across 5 `text` deltas** - the text is emitted by `message_update` (streaming), `message_end` (full text), and `agent_end` (full text again).

The server resolves its store directories with hard-coded `path.resolve("chat-history-store")` / `path.resolve("documents-store")` and binds to `HOST=localhost PORT=3000`. `PORT`/`HOST` are already env-overridable; the store dirs are not, so tests cannot isolate state without polluting the user's real data.

Relevant existing specs: `chat-history`, `document-management`, `tool-use-rendering`. None currently define the assistant-text streaming contract.

## Goals / Non-Goals

**Goals:**
- A Playwright E2E suite that boots the real server and drives the real browser UI, covering app navigation, document upload/list/view/delete, chat-history new/list/view, and one real chat turn.
- Test isolation: throwaway store directories per run, never touching the user's `chat-history-store/` or `documents-store/`.
- Fix the duplicate assistant-text broadcast so each text segment is delivered to the client exactly once per turn, for both streaming and non-streaming model responses.
- Make URL document ingestion work in proxy environments (Node's bare `fetch` ignores `http_proxy`).
- A single `npm run test:e2e` command that installs/launches everything.

**Non-Goals:**
- Unit tests for every module. (E2E first; unit coverage can follow.)
- Stubbing/mocking the LLM for fully deterministic chat tests. (The chat-turn test uses the real configured provider; a stub is a future improvement if flakiness warrants.)
- A CI workflow / GitHub Actions integration. (Local run first.)
- Changing the WS or REST protocol. (The duplicate-text fix only removes redundant `text` events.)
- Resuming past chat sessions into the live agent. (Explicitly out of scope per the existing `chat-history` spec.)

## Decisions

### Decision 1: Playwright (real browser) over node:test API tests
**Choice:** `@playwright/test` driving Chromium against the real UI.
**Why:** The duplicate-text bug is a *rendering* defect - it only manifests as accumulated text in the DOM. A browser-based assertion (`expect(assistantBubble).toHaveText("ping-pong")`) catches it directly; an API-level WS test would only see the duplicated deltas and would have to re-derive the "rendered once" contract. Playwright also exercises the real vanilla-JS frontend (sidebar tabs, file upload via `input[type=file]`, dynamic rows) that pure API tests cannot.
**Alternatives considered:**
- `node:test` + `ws` client hitting the REST/WS APIs directly. Lighter, no browser download, but blind to the DOM and to the duplicate-rendering symptom the user would actually see. Kept as a possible future layer for fast API smoke tests.
- Vitest + jsdom. Simulates the DOM, but `app.js` uses real `WebSocket`/`fetch` and DOM APIs that jsdom only partially implements; high friction for low fidelity.

### Decision 2: Test isolation via env-overridable store directories
**Choice:** Add `CHAT_HISTORY_STORE_DIR` and `DOCUMENTS_STORE_DIR` env overrides. `chat-history.js` and `documents.js` accept the directory (defaulting to the current hard-coded path) so production behavior is unchanged. Tests pass a temp directory (e.g. `os.tmpdir()/paas-e2e-<run>/...`) and clean it on teardown.
**Why:** The server also resolves `public/`, `skills/`, and `mcp.json` relative to `cwd`, so running the server from a temp `cwd` to isolate stores would break static serving and skill loading. Env-overridable store dirs isolate *only* the mutable state.
**Alternatives considered:**
- Run the server with `cwd` = temp dir. Rejected (breaks `public/`, `skills/`, `mcp.json`).
- Copy/restore the real store dirs around each run. Rejected (fragile, risks the user's data).

### Decision 3: Server launched by Playwright `webServer`, one instance per suite
**Choice:** `playwright.config` uses `webServer` to run `node server.js` with `PORT=${E2E_PORT}` (default 3100), `HOST=127.0.0.1`, and the temp store-dir env vars, waiting for the `Platform running at` stdout line, reusing one server for the whole suite and tearing it down after.
**Why:** Matches production reality (one shared agent session serving all clients) and is fast - the agent/MCP connections are established once. `HOST=127.0.0.1` avoids macOS `localhost`->`::1`-only binding ambiguity so Playwright's `http://127.0.0.1:PORT` base URL reliably connects.
**Alternatives considered:**
- Per-test server restart. Rejected (agent init + MCP connect takes seconds; would make the suite slow).
- Assume an already-running server. Rejected (defeats the purpose - the original bug was a stale server; the suite must boot fresh code).

### Decision 4: Chat-turn test uses the real LLM, isolated as a `@smoke` project
**Choice:** The chat-turn E2E test sends one short prompt and waits for `done`, making one real call to the configured Volces provider. It is tagged into a separate Playwright project (`@smoke`) so `npm run test:e2e` (default) can run the deterministic, no-LLM tests fast, and `npm run test:e2e:smoke` runs the full set including the chat turn.
**Why:** The duplicate-text fix and chat-history persistence-on-`agent_end` can only be verified end-to-end through a real agent turn. The provider already works (verified during investigation). Isolating it keeps the fast suite green offline.
**Alternatives considered:**
- Point the test server at a local stub OpenAI endpoint via `VOLCES_BASE_URL`. Deterministic and free, but the pi SDK's provider expects a specific OpenAI-completions surface; building a faithful stub is non-trivial and deferred.

### Decision 5: Duplicate-text fix - stream deltas, emit final text exactly once with a per-turn fallback
**Choice:**
- Keep `message_update` `text_delta` -> `broadcast({type:"text", delta})` for live streaming (unchanged).
- Remove the full-text `broadcast({type:"text"})` from `message_end` (it duplicates the streamed text).
- In `agent_end`: keep the chat-history persistence, but remove the unconditional full-text re-broadcast. Instead, broadcast the final assistant text **only if no text was streamed this turn**, tracked by a per-turn flag (`streamedTextThisTurn`, set true on the first `text_delta`, reset on `agent_start`). This yields exactly-once emission for both streaming models (deltas carry it) and non-streaming models (the `agent_end` fallback emits it once).
**Why:** Verified data (27 chars / 5 deltas for a 9-char reply) confirms three emission points. The per-turn flag is the minimal change that is robust to models that don't stream, without client-side deduplication.
**Alternatives considered:**
- Remove text from both `message_end` and `agent_end`, rely solely on streaming. Rejected: a non-streaming model response would never appear in the UI.
- Deduplicate by content on the client. Rejected: pushes a server bug to every client; the server should emit correctly.

### Decision 6: URL ingestion proxy support via `undici` `ProxyAgent`
**Choice:** In `fetchUrlAsText`, when `process.env.https_proxy` or `process.env.http_proxy` is set, construct `new ProxyAgent(proxyUrl)` and pass it as `fetch`'s `dispatcher` option. SSRF checks (`isPrivateHost`) still run on the target host first; the proxy is only the transport. No proxy env -> bare `fetch` (current behavior).
**Why:** Node's global `fetch` (undici) ignores `http_proxy`/`https_proxy` by default, which is exactly why `https://example.com` failed with "fetch failed" in this proxy environment. `undici` is the engine Node's fetch already uses; adding it as an explicit dependency gives a stable `ProxyAgent` without switching to `node-fetch` + `https-proxy-agent`.
**Alternatives considered:**
- `https-proxy-agent` with the `http`/`https` modules. Rejected: would mean abandoning `fetch` for URL ingestion and re-implementing redirect/timeout handling.
- Shell out to `curl`. Rejected: non-portable, harder to reason about SSRF/limits.

### Decision 7: Serialize document-list fetches in the UI to fix a status race
**Choice:** In `public/app.js`, chain `fetchDocumentList` calls through a single promise so they run sequentially; the latest-issued GET is applied last.
**Why:** Found while stabilizing the documents E2E test, which intermittently stuck a row on `indexing`. Root cause: `fetchDocumentList` was called concurrently - once from `handleAddResponse` after an add, and once from `updateDocumentStatus` re-fetching when a `documents_status` event arrived for a doc not yet in `docList`. If the earlier-issued GET (status `indexing`) resolved *after* the later one (status `ready`), the stale response clobbered the fresh one and, with no further events to correct it, the badge stayed on `indexing` - visibly indistinguishable from a failed upload. Document status only progresses forward (`queued` -> `indexing` -> `ready`), so serializing and letting the latest fetch win is both correct and minimal.
**Alternatives considered:**
- Drop the re-fetch in `updateDocumentStatus`. Rejected: breaks multi-tab (a doc added in another tab would never render until a manual refresh).
- Optimistic-only updates without re-fetch. Rejected: a row that does not yet exist in `docList` cannot be updated in place.

## Risks / Trade-offs

- **[Chat-turn test flaky from LLM network/latency]** -> Isolated as `@smoke`; generous timeout (60 s); the test asserts structural facts (a non-empty assistant bubble, history has a user + assistant message, rendered text is not triplicated) rather than exact model wording.
- **[Playwright browser download blocked on first run]** -> Document `http_proxy=http://127.0.0.1:7892 npx playwright install chromium` in the e2e README; the proxy is already known-good in this environment.
- **[Duplicate-text fix regresses non-streaming models]** -> The `streamedTextThisTurn` fallback in `agent_end` emits the final text once when nothing streamed; the chat-turn E2E guards the streaming path.
- **[`undici` version drift vs Node's bundled fetch]** -> Pin `undici` to a recent stable major; `ProxyAgent` + `dispatcher` is a stable, long-standing API.
- **[Test port 3100 collision]** -> Overridable via `E2E_PORT`; `webServer` fails fast with a clear message if the port is taken.
- **[One shared agent across the suite]** -> Matches production, but a failed/partial agent turn in one test could bleed state into the next. Mitigation: the chat-turn test is last in the smoke project; non-LLM tests do not prompt the agent.

## Migration Plan

- **Deploy:** `npm install` (pulls `@playwright/test`, `undici`); `npx playwright install chromium`; `npm run test:e2e`. The store-dir env vars default to the current hard-coded paths, so production behavior is identical without env set. The duplicate-text fix and URL proxy fix take effect on the next server restart.
- **Rollback:** Revert the `server.js` broadcast change and `fetchUrlAsText` change; delete `e2e/` and `playwright.config`. The env-overridable store dirs are additive and safe to leave. No data migration is involved (store file formats are unchanged).

## Open Questions

- Should the chat-turn `@smoke` test later move to a stubbed LLM for determinism? Defer until flakiness is observed.
- Do we want the fast E2E suite wired into a pre-commit or CI hook? Out of scope here; revisit once the suite is green locally.
