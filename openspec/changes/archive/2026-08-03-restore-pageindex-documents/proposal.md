## Why

The current WeKnora knowledge platform is too heavy for personal/small-team use - it requires a remote server with Postgres + Redis, adding deployment complexity and network dependency. Users want a fully local, embedded document knowledge base that supports Office documents (Word, Excel) without external infrastructure.

## What Changes

- **Remove WeKnora integration** - Delete `weknora.js`, `/weknora-web` proxy, `WeKnoraPage` component, and remove WeKnora configuration from `.env`. **BREAKING**: Users must remove `WEKNORA_BASE_URL` from their `.env`.
- **Restore `documents.js` module** - Rebuild document RAG using PageIndex (reasoning-based indexing) through LlamaIndex.TS framework with SQLite persistence.
- **Add enhanced format support** - Integrate `@llamaindex/readers` to parse Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) files in addition to existing formats.
- **Re-add Documents panel UI** - Restore the React `DocumentsPage` at `/documents` route with upload forms, status tracking, collections management, and query interface.
- **Re-enable drag-drop upload** - Add file drop handlers back to `Composer.tsx` so users can drop documents directly in the chat input.
- **Restore collections API** - Reimplement named document groups for organizing related files across different topics/projects.
- **Maintain chat integration** - Enable referencing indexed documents in conversations (same as before).

## Capabilities

### New Capabilities
- `pageindex-storage`: Backend module that indexes documents using PageIndex library (vectorless reasoning-based RAG), persisted to SQLite, accessed through LlamaIndex.TS framework. Supports PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML formats.
- `document-management-ui`: React Documents page at `/documents` route showing upload forms, per-document status (queued/indexing/ready/error), file listing, search/query interface, and management controls.
- `drag-drop-upload`: Document upload via drag-and-drop or paste in the chat Composer component, auto-detecting file type by extension.
- `document-collections`: Named groups of documents that can be organized by topic/project, with membership management (add/remove documents) and scoped querying within collections.

### Modified Capabilities
- `knowledge-collection-ui`: **REMOVED** — Replaced by restored Documents panel. Knowledge panel UI replaced entirely.
- `open-connector`: Modified to exclude WeKnora-related endpoints (`/api/weknora/*`) when mounting routes.

## Impact

- **Dependencies**: Re-add `better-sqlite3`, `pageindex`, `@llamaindex/openai`, `@llamaindex/readers` packages. Remove WeKnora dependencies (none currently installed). No new npm packages beyond restoring what existed before.
- **New files**: `db.js` (SQLite persistence layer), `pageindex-bridge.js` (PageIndex integration adapter), `readers.js` (LlamaIndex readers wrapper), restore `documents.js`, `collections.js`, `DocumentsPage.tsx`, `useDocumentsStore.ts`.
- **Modified files**: `server.js` (remove WeKnora routes, add Documents/collections routes), `web/src/App.tsx` (add `/documents` route), `web/src/components/Sidebar.tsx` (replace "Knowledge" link with "Documents"), `web/src/hooks/useWebSocket.ts` (handle `documents_status` events), `web/src/types/ws.ts` (include `documents_status` message type), `.env` (remove `WEKNORA_*` vars, restore `DOCUMENTS_MODEL`).
- **Removed files**: `weknora.js`, `WebKnora.tsx` (or remove import), `/api/weknora/*` routes, all WeKnora-specific code.
- **Disk footprint**: SQLite database file (~10MB initial, grows with documents), no additional services needed. Much smaller than WeKnora's 3-process setup.
- **Migration**: No automatic migration needed. Users with WeKnora data would need to re-ingest into local documents store. The change is opt-in - users who prefer WeKnora can keep it (optional future addition).
- **No breaking changes to chat behavior**: Core chat functionality unchanged; documents are an optional capability alongside OpenConnector/LiteLLM panels.

