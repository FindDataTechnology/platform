## 1. Dependencies & Setup

- [x] 1.1 Add `pageindex` to `package.json` dependencies and run `npm install`
- [x] 1.2 Add `multer` (multipart file upload) and `turndown` (HTML→Markdown for URL ingestion) to dependencies and install
- [x] 1.3 Confirm the installed `pageindex` package's named exports (`PageIndex`, `indexPdf`, `mdToTree`) by reading `node_modules/pageindex/dist/index.d.ts`; record the exact import names to use
- [x] 1.4 Add `knowledge-store/` to `.gitignore` and ensure the directory is created at startup if missing

## 2. Knowledge Module Core (`knowledge.js`)

- [x] 2.1 Create `knowledge.js`: instantiate `pageindex` with `{ baseUrl: VOLCES_BASE_URL, apiKey: VOLCES_API_KEY, model: PAGEINDEX_MODEL }` (export a `PAGEINDEX_MODEL` constant defaulting to `deepseek-v4-pro`, swappable to `glm-5.2`)
- [x] 2.2 Implement `manifest.json` load/save with atomic write (temp file + rename); implement `initStore()` to create the store dir and load existing manifest + doc statuses on startup
- [x] 2.3 Implement document id generation and manifest entry creation with initial status `queued` (fields: id, name, type, status, addedAt, fileName)
- [x] 2.4 Implement the ingestion pipeline per type: PDF via `fromPdf`, Markdown via `mdToTree`, plain text wrapped as a temp `.md` then `mdToTree`, URL fetched (with loopback/private-host block, size cap, timeout) and converted via `turndown` to a temp `.md` then `mdToTree`
- [x] 2.5 Implement a serialized async indexing queue: one document at a time, each job wrapped in try/catch; on success persist `<docId>.json` (full `PageIndexResult` + type + addedAt) and set manifest status `ready`; on failure set status `error` with message
- [x] 2.6 Implement status-event emission through an injected `broadcast` callback (`queued`/`indexing`/`ready`/`error`), including id, name, status, and error message
- [x] 2.7 Implement `listDocuments()` (from manifest), `removeDocument(id)` (delete `<docId>.json` + remove manifest entry + atomic manifest rewrite), and temp-file cleanup via `try/finally` around each ingestion job
- [x] 2.8 Implement `queryCollection(query)`: load persisted trees, ask the configured LLM to answer using the relevant tree sections, return the answer plus source document name(s); return empty result when the collection is empty

## 3. Server Wiring (`server.js`)

- [x] 3.1 Add `express.json()` body parsing and `multer` middleware for multipart file uploads
- [x] 3.2 Import `knowledge.js`, call `initStore()` at startup, and pass the existing `broadcast` function so status events flow over WebSocket
- [x] 3.3 Add `POST /api/knowledge/documents` accepting either a multipart file upload (PDF/Markdown) or JSON `{ type: "text"|"url", content|url, name }`; enqueue the document and return `{ id, status: "queued" }`
- [x] 3.4 Add `GET /api/knowledge/documents` returning the collection list from the manifest
- [x] 3.5 Add `DELETE /api/knowledge/documents/:id` removing the document's index and manifest entry
- [x] 3.6 Add `POST /api/knowledge/query` accepting `{ query }` and returning the retrieval result with source attribution
- [x] 3.7 Broadcast `knowledge_status` events via the existing `broadcast()` so all connected clients receive live status; no special server-side reconnect handling (clients re-fetch the list on reconnect)

## 4. Frontend UI (`public/`)

- [x] 4.1 Add a "Knowledge" panel to `index.html` with: an add-documents area (file picker, plain-text area, URL field), a collection list, and a query box; add a toggle between chat and knowledge views
- [x] 4.2 Add styles to `style.css` for the panel layout, document list rows, and status badges (`queued`/`indexing`/`ready`/`error`) consistent with the existing chat aesthetic
- [x] 4.3 In `app.js`, implement the panel toggle and fetch + render the collection list (GET) when the panel opens
- [x] 4.4 Implement the three add-document flows (file upload, text submit, URL submit) posting to `POST /api/knowledge/documents` and appending the new `queued` entry to the list
- [x] 4.5 Listen for `knowledge_status` WebSocket events and update the matching document's status badge live (no reload)
- [x] 4.6 Implement the per-document remove button calling `DELETE /api/knowledge/documents/:id` and removing the row
- [x] 4.7 Implement the query box: submit to `POST /api/knowledge/query` and render the returned answer/excerpt with source document name(s); show an empty-result state when nothing matches
- [x] 4.8 On WebSocket reconnect, re-fetch and refresh the collection list

## 5. Validation & Polish

- [x] 5.1 Smoke test: add a sample PDF and a Markdown file via the UI; confirm status progresses to `ready` and the documents persist across a server restart
- [x] 5.2 Smoke test: add a plain-text note and a web page URL; confirm indexing completes and a query returns content with source attribution
- [x] 5.3 Verify failure isolation: submit an unreadable PDF and an unreachable URL; confirm each is marked `error` without crashing the server and without blocking other documents
- [x] 5.4 Verify existing chat behavior (streaming, tool calls, model switching, skills) is unchanged
