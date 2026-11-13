## 1. Setup & dependencies

- [x] 1.1 Add `llamaindex`, `@llamaindex/openai`, `@llamaindex/readers` to `package.json` dependencies and run `npm install`
- [x] 1.2 Verify LlamaIndex.TS imports cleanly under the no-build ESM setup (`node -e "import('llamaindex').then(m=>console.log(Object.keys(m).slice(0,5)))"`) and that `@llamaindex/openai` `OpenAI` accepts a `baseURL` option
- [x] 1.3 Archive existing `knowledge-store/` to `knowledge-store.archive/` (preserve user data; do not delete)

## 2. Document management (LlamaIndex.TS, replaces knowledge.js)

- [x] 2.1 Create `documents.js` with `initStore({ baseUrl, apiKey, model, broadcast })` that sets `Settings.llm = new OpenAI({ model, apiKey, baseURL, temperature: 0.2 })` and `process.env.OPENAI_BASE_URL`/`OPENAI_API_KEY` (mirroring `knowledge.js`); use `DOCUMENTS_MODEL` env var (default `deepseek-v4-pro`)
- [x] 2.2 Implement `addDocument({ type, name, buffer, content, url })` returning `{ id, status: "queued" }`, with a serialized indexing queue (`queue = queue.then(...)`) and per-document failure isolation
- [x] 2.3 Implement ingestion per type: PDF -> `PDFReader`, Markdown -> `MarkdownReader`, text -> `Document` from raw text, URL -> SSRF-guarded fetch (reuse `isPrivateHost` + 2 MB / 15 s cap) wrapped in a `Document`
- [x] 2.4 Build a `SummaryIndex` (vectorless) from each document's nodes and persist to `documents-store/<id>/` via a LlamaIndex storage context; write `documents-store/manifest.json` atomically (temp + rename)
- [x] 2.5 Implement `listDocuments()`, `getDocumentContent(id)` (extracted text), `removeDocument(id)` (idempotent: remove manifest entry + best-effort delete `documents-store/<id>/`)
- [x] 2.6 Implement restart reconciliation: on `initStore`, mark any doc left `queued`/`indexing` as `error`
- [x] 2.7 Implement `queryCollection(query)` retrieving over all `ready` docs' `SummaryIndex` query engines, returning `{ answer, sources }`; empty answer + no sources when none ready
- [x] 2.8 Emit `documents_status` WS events on each status transition (`queued`/`indexing`/`ready`/`error`) via the injected `broadcast`

## 3. Document routes & wiring (server.js)

- [x] 3.1 Add `/api/documents/*` routes: `POST /api/documents` (multipart upload via existing `multer` + JSON text/url), `GET /api/documents`, `GET /api/documents/:id` (content), `DELETE /api/documents/:id`, `POST /api/documents/query`
- [x] 3.2 Call `documents.initStore({ baseUrl, apiKey, model: DOCUMENTS_MODEL, broadcast })` at startup (same site as the former `knowledge.initStore`); gate on provider config and log+continue if missing
- [x] 3.3 Confirm the frontend `documents_status` event path renders (handled in group 5)

## 4. Chat history

- [x] 4.1 Create `chat-history.js` with `initChatHistory()` (ensure `chat-history-store/`), `listSessions()`, `getSession(id)`, `newSession()`, and `appendMessage(role, content)` operating on the current in-memory session id
- [x] 4.2 Persist each session as `chat-history-store/<sessionId>.json` = `{ id, title, createdAt, updatedAt, messages: [{role, content, ts}] }` via atomic temp+rename; derive `title` from the first user message (truncated)
- [x] 4.3 Add `/api/chat-history/*` routes: `GET /sessions`, `GET /sessions/:id`, `POST /sessions` (new); not-found returns 404
- [x] 4.4 Wire append in `server.js`: on `prompt` WS message append the user turn; on agent `done` append the accumulated assistant final text (accumulate streamed `text` deltas during the turn)

## 5. OpenConnector native web UI proxy

- [x] 5.1 Verify the running runtime at `OPENCONNECTOR_BASE_URL` serves a browser dashboard (e.g. `curl -sI $OPENCONNECTOR_BASE_URL/` and inspect HTML). If none exists, switch to the D7 fallback (add OAuth connect to the existing panel via the `/api/openconnector/*` proxy) and skip 5.2-5.4
- [x] 5.2 Add a reverse-proxy mount at `/oc-web` and `/oc-web/*` in `server.js` that forwards method/body/query to `<runtime>/<path>` with token selection by family (`admin` for UI shell + `/api/*`, `runtime` for `/v1/*` + `/mcp`), streaming arbitrary content types; strip any client `Authorization`; constrain upstream to the configured base URL
- [x] 5.3 Apply asset-path mitigation: inject `<base href="/oc-web/">` into the proxied HTML and proxy common asset roots (`/assets`, `/static`) under `/oc-web/*`; verify the UI renders and can call the runtime API through the proxy
- [x] 5.4 Confirm tokens never reach the browser (grep proxied responses / network tab): no `Authorization` value, no runtime token in any client-visible response

## 6. Sidebar navigation & frontend (index.html, app.js, style.css)

- [x] 6.1 Restructure `index.html`: replace header toggle buttons with a `<nav class="sidebar">` (tabs: Chat, Chat History, Documents, OpenConnector) + `<main>` content area; keep existing panels as children of `<main>`
- [x] 6.2 Add `style.css` sidebar layout (persistent left column, active-tab styling, full-height main area) responsive enough for the existing single-column flow
- [x] 6.3 Update `app.js` `showView(name)` to switch active panel + active-tab class; remove `knowledge-toggle`/`openconnector-toggle` button handlers; default to Chat on load
- [x] 6.4 Rename the Knowledge panel -> Documents and rewire its calls from `/api/knowledge/*` to `/api/documents/*` and the `knowledge_status` event to `documents_status`; add document-content view + delete
- [x] 6.5 Add the Chat History tab UI: list sessions (title, updatedAt) on open, click to view messages read-only; no resume action
- [x] 6.6 Add the OpenConnector management sub-view: an `<iframe src="/oc-web">` filling the tab, alongside the existing Actions panel (sub-tab switch between Manage and Actions)

## 7. Removal & cleanup

- [x] 7.1 Remove `/api/knowledge/*` routes and the `knowledge_status` broadcast from `server.js`
- [x] 7.2 Delete `knowledge.js`; remove `pageindex` and `turndown` from `package.json` and run `npm install` to prune
- [x] 7.3 Update `CLAUDE.md`: knowledge.js -> documents.js (LlamaIndex.TS, SummaryIndex), `documents-store/`, `DOCUMENTS_MODEL`, new `/api/documents/*` + `/api/chat-history/*` + `/oc-web` proxy, sidebar nav, chat-history.js
- [x] 7.4 Update `mcp.example.json` doc comment if it references knowledge (it shouldn't) and `.env`/config docs for `DOCUMENTS_MODEL`

## 8. Verification

- [x] 8.1 `npm start` with full config: server starts, sidebar shows 4 tabs, Chat works
- [x] 8.2 Documents: upload a PDF and a URL, observe `documents_status` transitions to `ready`, list/view/delete work, query returns an answer with sources
- [x] 8.3 Chat History: send a few prompts, open the tab, confirm the session is listed and viewable read-only; start a new session and confirm the old one remains
- [x] 8.4 OpenConnector: open the tab, confirm the embedded native UI loads in the iframe and can manage a connection through it; confirm tokens are absent from the browser
- [x] 8.5 Graceful degradation: unset `OPENCONNECTOR_BASE_URL` and provider config, restart, confirm server starts and tabs show disabled states without crashing
