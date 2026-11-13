## 1. Setup & investigation

- [x] 1.1 Probe `@llamaindex/readers`: confirm the reader classes and their async load APIs for `.docx`, `.csv`, `.html`/`.htm`, and `.json`; record which readers require optional peer dependencies. FINDINGS: all four expose `loadDataAsContent(Uint8Array): Promise<Document[]>` and work with no new deps (`mammoth`, `csv-parse`, `@discoveryjs/json-ext`, `htmlparser2` are present transitively). `@llamaindex/readers` ships **no PPTX reader**, so PPTX is dropped from scope (spec/design/proposal updated).
- [x] 1.2 Confirm the current `list_models` WebSocket handler in `server.js` (how the model list is sourced today) and how the model selector is rendered in `public/app.js` (dropdown vs free-text input), to scope the model-list change precisely.

## 2. LlamaIndex readers adapter (backend)

- [x] 2.1 Create a `readers.js` module (or extend `pageindex-bridge.js`) exporting a function that maps a supported extension to its `@llamaindex/readers` reader and returns extracted text from the uploaded `Buffer`; cover `.docx`, `.csv`, `.html`/`.htm`, `.pptx`, `.json`.
- [x] 2.2 Add any required reader peer dependencies to `package.json` and run `npm install`; if a reader's peer dep fails to install or is too heavy, exclude that type from the supported set and log a notice rather than aborting startup (graceful degradation).
- [x] 2.3 Wire the new types into `buildIndex` in `pageindex-bridge.js`: for docx/csv/html/json, extract text via the reader adapter, then build a PageIndex tree (`simpleTree`, or `markdownToTree` for HTML) and persist via the existing `persistIndex` -> `doc_index` path.
- [x] 2.4 Update the upload route in `server.js` (`POST /api/documents`): replace the `ext === ".pdf" ? "pdf" : "markdown"` mapping with an extension -> type map covering all supported types; set the document `type` accordingly so the bridge dispatches correctly.

## 3. Unsupported-type rejection

- [x] 3.1 Define a single server-side supported-extension set (`.pdf`, `.md`, `.markdown`, `.docx`, `.csv`, `.html`, `.htm`, `.json`) as the source of truth; in the upload route, return HTTP 415 with a clear message naming the supported types for any other extension, without creating a document record or queueing indexing.
- [x] 3.2 Confirm JSON-body uploads (`type:"text"` / `type:"url"`) still validate and ingest as before (no regression).

## 4. Frontend upload-type expansion

- [x] 4.1 Update the file-picker `accept` attribute in `public/index.html` to include `.docx,.csv,.html,.htm,.json` alongside the existing PDF/Markdown entries.
- [x] 4.2 Update `fileTypeFor` in `public/app.js` to map the new extensions to their types instead of defaulting unknown extensions to `"text"`.
- [x] 4.3 Update the drag-and-drop and clipboard-paste handlers in `public/app.js` to submit supported types and, on HTTP 415, surface a transient UI notice that the file type is not supported (instead of silent failure/garbling).
- [x] 4.4 Verify end-to-end that both the Documents-tab upload form and the chat-window drag-drop/paste accept each new type and reach `ready`.

## 5. LiteLLM model-list sourcing

- [x] 5.1 Add a `fetchLitellmModels()` helper that performs `GET ${LITELLM_BASE_URL}/v1/models` authenticated with `LITELLM_API_KEY` (bounded short timeout, `--noproxy`/direct to the IP per project proxy rules), maps `data[].id` to `{id, provider:"litellm"}`, and returns `null` on failure.
- [x] 5.2 Add a short-TTL in-memory cache (default ~30 s) for the LiteLLM model list so repeated `list_models` requests do not hammer the proxy.
- [x] 5.3 Update the `list_models` WS handler in `server.js`: when LiteLLM is configured, return the fetched (cached) LiteLLM models; on fetch failure/timeout, log a warning and fall back to configured-provider models that have configured auth; deduplicate by id.
- [x] 5.4 Confirm `set_model` and the `/model` command validate against the same LiteLLM-sourced list and accept the litellm ids; verify switching to a litellm model broadcasts `model_changed`.
- [x] 5.5 Update the model selector in `public/app.js` (and the `/model` autocomplete, if present) to render the LiteLLM-sourced list; confirm selecting a model switches the active model.

## 6. Collections - database

- [x] 6.1 Add a new schema migration in `db.js` creating `collections (id, name, description, created_at)` and `collection_documents (collection_id, document_id, added_at, PRIMARY KEY(collection_id, document_id), FOREIGN KEYS ON DELETE CASCADE)` tables.
- [x] 6.2 Add typed helpers in `db.js`: `createCollection`, `listCollections` (with `documentCount`), `getCollection`, `renameCollection`, `deleteCollection`, `addDocumentToCollection`, `removeDocumentFromCollection`, `listCollectionDocuments`; each no-ops / returns a safe value when the DB is not ready.
- [x] 6.3 Ensure deleting a document cascades-removes its memberships from every collection (rely on `FOREIGN KEY ... ON DELETE CASCADE` with `PRAGMA foreign_keys=ON`, already set).

## 7. Collections - routes & retrieval

- [x] 7.1 Mount `/api/collections` routes in `server.js` for list, create, rename, and delete - gated on `dbReady` (HTTP 503 with a clear message when the DB is unavailable).
- [x] 7.2 Mount membership routes: add a document to a collection, remove a document, and list a collection's members - with idempotent add/remove and an error for non-existent document or collection.
- [x] 7.3 Add a collection query endpoint (`POST /api/collections/:id/query`) that retrieves over only the collection's `ready` member documents via the existing `queryCollection` retrieval (filtered to member ids), returning an answer and source names; return an empty answer with no sources when the collection has no ready docs.
- [x] 7.4 Gate all collection routes on `dbReady`; verify they return 503 and do not crash when the DB is disabled.

## 8. Collections - frontend

- [x] 8.1 Add a Collections UI section in the Documents tab: list collections, create (name + optional description), rename, and delete.
- [x] 8.2 Add member management UI: add/remove documents to/from a collection and list a collection's documents.
- [x] 8.3 Add a "query this collection" affordance that posts to the collection query endpoint and displays the answer and source document names.
- [x] 8.4 Refetch the collection list after each synchronous mutation; show a notice when collections are disabled (DB off).

## 9. Verification

- [x] 9.1 Verify ingestion of each new type (`.docx`, `.csv`, `.html`, `.json`): upload -> `queued` -> `ready` -> queryable; verify a supported type whose extraction fails is marked `error` in isolation.
- [x] 9.2 Verify unsupported extensions (e.g. `.png`, `.zip`) return HTTP 415 from both the picker and drag-drop paths, surface a UI notice, and create no document record.
- [x] 9.3 Verify the model list reflects LiteLLM `/v1/models` (the four ids), that a model added/renamed in the LiteLLM admin UI appears without a server restart (within the TTL), and that the selector and `/model` switch to a litellm model; verify fallback when the proxy is unreachable.
- [x] 9.4 Verify collections: create/list/rename/delete, add/remove documents (idempotent), list members, delete-collection leaves documents intact, delete-document removes memberships, and query-within-collection (including the empty case).
- [x] 9.5 Verify graceful degradation: DB unavailable -> collections disabled (503), documents disabled, chat in-memory, server starts; LiteLLM unreachable -> model list falls back to configured-provider models.
- [x] 9.6 Extend the `e2e-testing` suite to cover the new upload types, unsupported-type rejection, LiteLLM model-list sourcing (with fallback), and collections CRUD + query.
