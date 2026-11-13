## Context

`pi-web-chat` is an Express + WebSocket server (`server.js`) that wraps the `@earendil-works/pi-coding-agent` SDK and serves a vanilla HTML/CSS/JS frontend from `public/`. It registers a custom OpenAI-compatible provider ("volces", pointing at 火山引擎's `ark.cn-beijing.volces.com` endpoint) with models `deepseek-v4-pro`, `deepseek-v4-flash`, and `glm-5.2`, and already holds the API key (`VOLCES_API_KEY`) and base URL (`VOLCES_BASE_URL`) at module scope. WebSocket clients receive streaming chat, tool, and thinking events via a `broadcast()` helper.

The change adds a PageIndex-backed knowledge collection. "PageIndex" here is the `pageindex` npm package - a TypeScript port of VectifyAI/PageIndex that performs **vectorless, reasoning-based RAG**: it uses an LLM to build a hierarchical tree index of a document (sections, summaries, page ranges) instead of embeddings. It is LLM-agnostic and accepts any OpenAI-compatible endpoint via `baseUrl` + `apiKey`, which lets us reuse the Volces provider. It natively handles PDF (`PageIndex.fromPdf` / `indexPdf`) and Markdown (`mdToTree`), and supports OCR on scanned PDFs (requires the Poppler system binary). The import is ESM from `"pageindex"` (entry `dist/index.js`), matching the project's `"type": "module"`.

## Goals / Non-Goals

**Goals:**
- Let users add four document types - PDF, Markdown, plain text/notes, and web page (URL) - through the website.
- Auto-index every added document with `pageindex` immediately (no manual save) and persist the index + metadata to disk so it survives restarts.
- Reuse the existing Volces OpenAI-compatible provider as PageIndex's reasoning model - no new credentials or external service account.
- Show the collection on the website: live per-document indexing status, browsing, removal, and a natural-language query box with source attribution.
- Stream indexing progress over the existing WebSocket layer.
- Keep the change additive: no break to existing chat behavior.

**Non-Goals:**
- Multi-user accounts, auth, or per-user collections (single shared collection, consistent with the single in-memory chat session).
- A vector database or embedding store (pageindex is deliberately vectorless).
- OCR-on-by-default (OCR requires Poppler; v1 indexes text-based PDFs; OCR is an opt-in path documented but not wired into the UI).
- Surfacing the knowledge collection as a tool the chat agent can call automatically (the agent is unaffected in v1; a future change can add an MCP/agent tool).
- Production hardening: rate limiting, access control, large-scale ingestion tuning.

## Decisions

### 1. Use the `pageindex` npm library directly, not `pageindex-mcp` or `@fastrag/pageindex`

**Choice:** Embed the `pageindex` library in a new `knowledge.js` module.

**Why:** The user wants a user-facing "add documents -> auto-save to PageIndex" module, which means the backend must drive indexing programmatically. The `pageindex` library is self-contained (no hosted account, no OAuth), works with our OpenAI-compatible Volces provider, and natively covers the requested document types. `pageindex-mcp` targets a hosted PageIndex service (requires an account/OAuth login) and exposes tools to an agent rather than powering a user-driven ingestion UI; `@fastrag/pageindex` is a chunking/vector SDK and a different mental model.

**Alternatives considered:** `pageindex-mcp` (account + OAuth overhead, agent-oriented), `@fastrag/pageindex` (vector-oriented, diverges from the requested reasoning-based PageIndex).

### 2. Reuse the Volces provider as PageIndex's LLM

**Choice:** Instantiate `pageindex` with `{ baseUrl: VOLCES_BASE_URL, apiKey: VOLCES_API_KEY, model: <a volces model id> }`.

**Why:** `pageindex` accepts any OpenAI-compatible `baseUrl`/`apiKey`. Volces is already configured and the key is already in `server.js`. One of the registered models (e.g. `deepseek-v4-pro` or `glm-5.2`) serves as the reasoning model. No new env vars or accounts.

**Trade-off:** Pageindex's default model is `gpt-4o-*`; we override with a Volces model. If a chosen Volces model struggles with pageindex's prompts, swap to another registered model. Model id is a single config constant in `knowledge.js`.

### 3. Persistence layout: `knowledge-store/` with per-document JSON + `manifest.json`

**Choice:** Create a `knowledge-store/` directory. Each indexed document writes `<docId>.json` (the full `PageIndexResult`: `docName`, `docDescription`, `structure` tree, plus `type`, `addedAt`). A `manifest.json` lists all documents with lightweight metadata (id, name, type, status, addedAt, fileName). On startup, `knowledge.js` reads `manifest.json` and loads each doc's status; ready docs are loaded lazily for queries.

**Why:** Simple, debuggable, filesystem-backed - consistent with the project's minimal-stack ethos (no DB). Atomic manifest writes (write temp + rename) prevent a crash from corrupting the registry.

**Alternatives considered:** SQLite (overkill for v1), a single giant JSON file (rewrite cost grows with collection; riskier on crash).

### 4. Ingestion pipeline per document type

**Choice:** Route each type to a pageindex entry point:
- **PDF** -> `PageIndex.fromPdf(filePath)` (text extraction; OCR path available but not wired into the UI in v1).
- **Markdown** -> `mdToTree(filePath)` (write uploaded `.md` to a temp file).
- **Plain text** -> wrap the text as a temp `.md` file and call `mdToTree`.
- **URL** -> `fetch` the page, convert HTML to Markdown (a small dependency such as `turndown`), write to a temp `.md` file, then `mdToTree`.

**Why:** pageindex exposes PDF and Markdown paths directly; text and URL reduce to Markdown, which pageindex handles well. Temp files are cleaned up after indexing; only the resulting JSON is persisted.

**Trade-off:** Adds an HTML-to-Markdown dependency for URL ingestion. Acceptable; it's small and the URL type was explicitly requested.

### 5. Serialized indexing queue with per-document failure isolation

**Choice:** A single in-process async queue indexes one document at a time. Each job is wrapped in try/catch: success -> status `ready` + persist; failure -> status `error` + error message. Status transitions emit WebSocket events via the existing `broadcast()`.

**Why:** Volces has rate limits and pageindex makes many sequential LLM calls per document; serial indexing avoids hammering the API and makes failures cleanly attributable to one document. The queue is in-memory; queued jobs are not persisted (only completed indexes are), which is acceptable for v1.

**Alternatives considered:** Parallel indexing (rate-limit risk, harder status attribution), background worker process (complexity overkill).

### 6. HTTP endpoints for commands + WebSocket for progress

**Choice:** Add REST endpoints on the existing Express app:
- `POST /api/knowledge/documents` (multipart file OR JSON `{ type: "text"|"url", content|url, name }`) -> enqueues, returns `{ id, status: "queued" }`.
- `GET /api/knowledge/documents` -> list from manifest.
- `DELETE /api/knowledge/documents/:id` -> remove index + manifest entry.
- `POST /api/knowledge/query` `{ query }` -> reasoning-based retrieval result with source attribution.

Indexing progress flows over the existing WebSocket as new message types (`knowledge_status`, `{ id, name, status, error? }`), reusing `broadcast()`. `express.json()` and a multipart handler (e.g. `multer`) are added for request parsing.

**Why:** Commands map naturally to REST; streaming status maps naturally to the existing WS broadcast pattern. Keeps the chat WS protocol and the knowledge WS events on one connection.

**Alternatives considered:** All-WebSocket (less conventional for file uploads), SSE (a second channel to manage).

### 7. UI panel: a section/tab in the existing layout, vanilla JS

**Choice:** Add a "Knowledge" panel to `public/index.html` (toggled alongside the chat view), with an add-documents area (file picker, text area, URL field), a collection list with status badges and remove buttons, and a query box. `public/app.js` gains handlers that call the REST endpoints and listen for `knowledge_status` WS events to update badges live. `public/style.css` gains styles matching the existing chat aesthetic.

**Why:** Matches the project's vanilla-JS, no-build-step frontend convention. Reuses the single WS connection the page already maintains.

### 8. Retrieval: reasoning-based over persisted trees

**Choice:** For a query, `knowledge.js` loads the persisted `PageIndexResult` trees and asks the configured LLM to answer the question using the relevant tree sections, returning the answer plus the source document name(s). This mirrors pageindex's vectorless philosophy (the tree is the index; the LLM reasons over it).

**Why:** No embedding/vector step to build or maintain. Source attribution is straightforward because each tree node knows its document.

**Trade-off:** Query cost/latency scales with collection size (more tree context to consider). For v1's single-user scale this is fine; a future change can add tree-pruning or per-doc preselection.

## Risks / Trade-offs

- **Native dependency (`pdf-poppler`) and Poppler binary** -> `pdf-poppler` is used by pageindex's OCR path; text-based PDF extraction uses `pdf-parse` (pure JS). If `pdf-poppler` fails to install on a platform, document the prerequisite and keep OCR optional. Mitigation: pin/verify install during `/opsx:apply`; surface a clear error if a PDF needs OCR but Poppler is absent.
- **LLM cost and latency per document** -> Each document triggers many sequential LLM calls. Mitigation: serialized queue, live `indexing` status in the UI so the user sees progress, and a note that large PDFs take time.
- **`pageindex` package import/exports verification** -> The npm package is named `pageindex` (ESM, entry `dist/index.js`) but its README references the `bun-pageindex` import name. Mitigation: at `/opsx:apply`, confirm the exact named exports (`PageIndex`, `indexPdf`, `mdToTree`) from `node_modules/pageindex/dist/index.d.ts` before wiring; adjust imports accordingly.
- **Volces model compatibility with pageindex prompts** -> pageindex was designed around `gpt-4o`. A Volces model may produce weaker trees. Mitigation: make the model id a single constant; allow swapping to `deepseek-v4-pro` or `glm-5.2`; validate on a sample PDF during apply.
- **URL fetch: SSRF and unbounded content** -> Fetching arbitrary URLs risks SSRF and huge pages. Mitigation: block private/loopback hostnames, cap fetched content size, set a fetch timeout.
- **Concurrent chat + indexing load on one Volces key** -> Indexing competes with chat for the same provider/key. Mitigation: serialized indexing keeps it bounded; acceptable for v1 single-user.
- **Temp file cleanup** -> Temp `.md` files for text/URL ingestion must be removed after indexing. Mitigation: `try/finally` cleanup around each ingestion job.

## Open Questions

- ~~Exact named exports of the installed `pageindex` package~~ - **Resolved at apply:** the package `pageindex` (ESM, entry `dist/index.js`) exports `PageIndex`, `markdownToTree` (takes a markdown string + docName), `indexPdf`, `parsePdf`, and `chatGPT` (reused for retrieval). `markdownToTree` accepts a string directly, so no temp files are needed for text/URL/markdown.
- ~~Which Volces model id yields the best pageindex results~~ - **Resolved at apply:** `deepseek-v4-pro` works (indexing completes in a few seconds for small docs). Both registered Volces models are reasoning models.
- Whether to later expose the collection to the chat agent as a retrievable tool - explicitly deferred (Non-Goal for v1).

## Implementation Notes (discovered during apply)

- **pageindex `baseUrl` bug (critical):** pageindex's `markdownToTree` and `PageIndex.fromPdf` pass `baseUrl: void 0` to their internal summary/description LLM calls. Its `getClient` falls back to `process.env.OPENAI_BASE_URL`, which defaults to `api.openai.com` - unreachable from this Volces-configured network, causing `APIConnectionTimeoutError` on every indexing call. **Fix:** `initStore()` sets `process.env.OPENAI_BASE_URL` and `process.env.OPENAI_API_KEY` to the Volces provider values, so all internal pageindex calls route correctly. This must stay in place; removing it breaks indexing.
- **PDF retrieval text:** pageindex's PDF tree nodes carry page ranges, not raw text, so detailed PDF queries returned "I don't know." `indexDocument` now also calls `parsePdf` to attach the extracted page text (`rawText`), which `buildDocContext` includes (truncated to 6000 chars) in query context. Markdown/text/URL trees already include node text via `addNodeText: true`.
- **Markdown file uploads** arrive as a `Buffer` (multer memory storage); `indexDocument` decodes it with `.toString("utf8")` before passing to `markdownToTree`.
- **Document name preservation:** `runIndex` keeps the user-provided name rather than adopting pageindex's `result.docName`, because pageindex returns `"Untitled"` for PDFs with empty title metadata.
- **Validation results (all passing):** PDF/Markdown/text/URL each index to `ready`; documents persist across restart; queries return answers with source attribution; an unreachable URL is marked `error` without crashing the server or blocking other queued docs (failure isolation); the existing WebSocket chat (streaming, `done`, model sync) is unchanged.
