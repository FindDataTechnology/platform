## Why

The web chat exposes pi-agent for conversation, but it has no memory of reference material — users cannot feed it their own PDFs, notes, or web pages and have that content available as searchable knowledge. Adding a PageIndex-backed knowledge collection lets users build a reusable, indexed knowledge base from multiple document types, with documents auto-indexed and persisted so they survive restarts and can be queried later.

## What Changes

- Add a backend knowledge-collection module that ingests documents of multiple types (PDF, Markdown, plain text/notes, and web pages via URL), indexes each with the `pageindex` npm library (vectorless, reasoning-based RAG — a TypeScript port of VectifyAI/PageIndex), and persists the resulting index + metadata to disk.
- Reuse the server's existing OpenAI-compatible LLM provider (Volces) as PageIndex's reasoning model via its `baseUrl`/`apiKey` options — no new API account required.
- Auto-save: every added document is indexed and written to the on-disk PageIndex store automatically; no manual "save" step.
- Add HTTP endpoints on the existing Express server and WebSocket messages for adding documents, listing the collection, tracking indexing progress, querying the collection, and removing documents.
- Add a "Knowledge Collection" panel to the web UI where users upload files, paste text or a URL, watch per-document indexing status, browse saved documents, and run queries against the collection.

## Capabilities

### New Capabilities
- `knowledge-collection`: Backend module that ingests PDF/Markdown/plain-text/URL documents, indexes them with the `pageindex` library using the configured OpenAI-compatible LLM, persists indexes and metadata to disk, and exposes retrieval/query plus management over HTTP and WebSocket.
- `knowledge-collection-ui`: Browser panel for adding documents (file upload, pasted text, URL), viewing real-time indexing status, browsing the saved collection, and querying it; auto-saves added documents to PageIndex.

### Modified Capabilities
<!-- No existing specs in openspec/specs/ are changing at the requirement level. The web-chat server/UI (from the build-pi-web-chat change) are extended at the implementation level — captured under Impact, not as spec deltas. -->

## Impact

- Dependencies: add `pageindex` (brings transitive `openai`, `pdf-parse`, `pdf-poppler`). Optional system dependency: Poppler (`brew install poppler`) required only for OCR on scanned PDFs; text-based PDFs work without it.
- New files: `knowledge.js` (the collection module: ingestion, indexing, persistence, retrieval), a `knowledge-store/` directory on disk for indexes + a `manifest.json` registry, plus UI additions in `public/index.html`, `public/app.js`, `public/style.css`.
- Modified files: `server.js` (mount knowledge endpoints, broadcast indexing-progress WS events, init the store at startup), `public/index.html` / `public/app.js` / `public/style.css` (new Knowledge panel).
- LLM cost: indexing calls the configured LLM per document (pageindex builds a hierarchical reasoning index); queries also call the LLM. No new credentials — reuses the Volces provider config already in `server.js`.
- No breaking changes to existing chat behavior; the knowledge module is additive and mounted alongside the existing routes.
