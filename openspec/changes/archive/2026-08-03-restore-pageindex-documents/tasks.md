## 1. Restore Core Infrastructure (db.js, pageindex-bridge.js)

- [x] 1.1 Create `db.js` - SQLite persistence layer with WAL mode, foreign keys, schema v1 migration for documents and doc_index tables. Handle graceful degradation if DB unavailable.
- [x] 1.2 Create `pageindex-bridge.js` - PageIndex integration adapter that LlamaIndex uses to save data into PageIndex index stored in SQLite. Implement reasoning-based retrieval over PageIndex trees.
- [x] 1.3 Re-add dependencies to package.json: `better-sqlite3`, `pageindex`, `@llamaindex/openai`
- [x] 1.4 Update server.js to remove WeKnora imports and mount Documents/collections routes instead

## 2. Enhanced Format Support (readers.js + documents.js)

- [x] 2.1 Create `readers.js` wrapper module for LlamaIndex document readers (DocxReader, XlsReader, PptxReader, CSVReader, HTMLReader)
- [x] 2.2 Restore `documents.js` module using LlamaIndex framework + PageIndex bridge via db.js
- [x] 2.3 Add support for DOCX, XLSX, PPTX formats alongside existing PDF, Markdown, text, URL
- [x] 2.4 Implement serialized indexing queue with per-document failure isolation
- [x] 2.5 Re-implement `initStore()` with Volces provider config for LLM calls

## 3. UI Restoration (React components + routes)

- [x] 3.1 Restore `DocumentsPage.tsx` component with upload form, document list, status tracking, query interface
- [x] 3.2 Add `/documents` route to `web/src/App.tsx`, replace or keep alongside WeKnora
- [x] 3.3 Update `Sidebar.tsx` to show "Documents" link instead of/nearside "Knowledge"
- [x] 3.4 Restore `useDocumentsStore.ts` hook to manage documents_status events
- [x] 3.5 Re-add drag-drop handlers to `Composer.tsx`

## 4. Collections Module

- [x] 4.1 Restore `collections.js` module for named document groups
- [x] 4.2 Add `/api/collections/*` REST endpoints (list, create, rename, delete, add/remove docs, query within collection)
- [x] 4.3 Wire up collections UI in Documents page (left sidebar tree of collections)
- [x] 4.4 Update WebSocket event types (`ws.ts`) to include `documents_status`

## 5. Cleanup & Migration

- [x] 5.1 Remove all WeKnora code: delete `weknora.js`, remove WeKnora routes from server.js
- [x] 5.2 Remove `WEKNORA_BASE_URL` and `WEKNORA_API_KEY` from .env.example and documentation
- [x] 5.3 Update README.md to reflect local PageIndex storage instead of remote WeKnora
- [x] 5.4 Test full flow: upload → index → query → chat integration

## 6. Testing & Verification

- [x] 6.1 Verify all supported formats upload successfully (.pdf, .docx, .csv, .html, .md, .txt, .json)
- [x] 6.2 Confirm indexing queue processes correctly with multiple simultaneous uploads
- [x] 6.3 Verify query returns relevant answers sourced from indexed content
- [x] 6.4 Test collections work correctly (create, add/remove docs, scoped queries)
- [x] 6.5 Confirm drag-drop upload works in any page context
- [x] 6.6 Validate server starts gracefully even if SQLite unavailable (graceful degradation)
