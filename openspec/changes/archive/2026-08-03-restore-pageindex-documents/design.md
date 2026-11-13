## Context

The project currently uses WeKnora (remote knowledge platform with Postgres + Redis) for document RAG, which is overkill for personal/small-team offline use. Users want a fully embedded solution that supports Office documents (Word, Excel) without external infrastructure. The previous `documents.js` implementation using PageIndex was removed in favor of WeKnora - we're restoring it with enhanced format support.

**Current State:**
- WeKnora running remotely at `http://23.144.68.246:30840`
- No local document storage or indexing capability
- Documents panel deleted when removing old `documents.js`
- Chat input has no file upload capability

**Target State:**
- Fully embedded PageIndex-based document RAG
- Local SQLite persistence (single file, no server)
- Support for Word (.docx), Excel (.xlsx), PowerPoint (.pptx) via LlamaIndex readers
- Full UI restoration with drag-drop upload and collections

## Goals / Non-Goals

**Goals:**
- Restore `documents.js` module using PageIndex library through LlamaIndex.TS framework
- Persist document records, source text, and PageIndex indices to SQLite
- Add enhanced format support (DOCX, XLSX, PPTX) alongside existing formats
- Re-add Documents UI at `/documents` route with upload forms, status tracking, query interface
- Enable drag-and-drop file uploads in any page context
- Restore collections feature for organizing documents into named groups
- Maintain graceful degradation pattern (server starts even if SQLite unavailable)

**Non-Goals:**
- Multi-workspace RBAC (Collections are simple named groups, not multi-tenant workspaces)
- Remote/hybrid deployment (all data stays local on user's machine)
- Vector embeddings (PageIndex is vectorless reasoning RAG - no embedding endpoint required)
- Removing LlamaIndex.TS (it stays as the framework for document parsing)
- Automatic migration from WeKnora (users must re-ingest docs locally)

## Decisions

### Decision 1: Use PageIndex through LlamaIndex bridge pattern
**Choice:** Integrate PageIndex via `pageindex-bridge.js` adapter, keeping LlamaIndex.TS as the data-management framework. Document readers parse files into LlamaIndex Documents; bridge feeds text to PageIndex for indexing; retrieval happens by reasoning over PageIndex trees via LLM.

**Rationale:** Matches the user's explicit direction ("use llamaindex as a framework, it can access the pageindex"). Investigation of archived change `sqlite-pageindex-storage` confirms this pattern worked before. PageIndex exposes only indexing (no retrieval API), so the bridge implements reasoning-based retrieval by flattening the tree and using LLM to select relevant nodes.

**Alternatives considered:**
- PageIndex standalone, LlamaIndex only for readers - rejected, user wants LlamaIndex as managing framework.
- Remove LlamaIndex entirely, use PageIndex directly - rejected, user explicitly asked to keep LlamaIndex.

### Decision 2: SQLite for all persistence via `better-sqlite3`
**Choice:** Single SQLite database file (`data/app.db`) for document records, source text, PageIndex indices, plus chat messages and preferences. Use synchronous `better-sqlite3` driver (prebuilt binaries available). Open with WAL mode for concurrent reads during serialization writes.

**Rationale:** Proven pattern from previous `sqlite-pageindex-storage` change. WAL mode allows concurrent readers while indexing writer remains serialized. `better-sqlite3` ships prebuilt binaries for macOS/Linux x64/arm64, avoiding build toolchain complexity. JSON-blob column stores PageIndex index trees versioned for future compatibility.

**Alternatives considered:**
- Keep file-based `documents-store/manifest.json` - rejected, user wants unified SQLite project database.
- Use Node 22+ `node:sqlite` - rejected, still experimental flag-gated API; `better-sqlite3` more stable.

### Decision 3: Enhanced format support via @llamaindex/readers
**Choice:** Install `@llamaindex/readers` package containing DocxReader, XlsReader, CSVReader, HTMLReader, JSONReader. Create wrapper module `readers.js` that abstracts reader selection by file extension mapping. Reject unsupported extensions with HTTP 415 response.

**Rationale:** LlamaIndex provides production-grade readers for Office documents. Extends beyond PageIndex's original PDF/text/Markdown/URL support to include DOCX/XLSX/PPTX users specifically requested. Extension-based routing keeps code clean and maintainable.

**Alternatives considered:**
- Custom parsers for each format - rejected, unnecessary reinvention when LlamaIndex readers exist.
- Send Word/Excel to WeKnora API only - rejected, user wants fully local solution for all formats.

### Decision 4: Collections as lightweight grouping mechanism
**Choice:** Simple collection system - named groups of documents with membership management. No RBAC, no multi-tenancy, just organization by topic/project. Each collection has id, name, description, documentCount, createdAt. Membership is many-to-many via SQLite junction table.

**Rationale:** User asked to keep "collections" but clarified it doesn't need full WeKnora-style multi-workspace complexity. Lightweight approach matches the "lite knowledge base" goal - enough structure for organization without operational overhead.

**Alternatives considered:**
- Folder-based hierarchy - simpler than named collections but less flexible.
- Tag/metadata system - powerful but overengineered for initial version.

### Decision 5: Drag-drop upload in Composer component
**Choice:** Re-add `onDrop` handler to React `Composer.tsx`. Listen for `dragover`, `dragleave`, `drop` events. On drop, extract files from `dataTransfer.files`, classify by extension, submit sequentially to `/api/documents` via multipart form. Show toast notifications per-file success/error.

**Rationale:** Restores UX parity with previous `documents.js` implementation. Drag-drop is natural for document workflows - users expect to drag files from Finder/Disk directly into app. Keeping it in Composer centralizes all uploads under single interaction point.

**Alternatives considered:**
- Dedicated upload button in Documents page only - works but less discoverable than universal drag-drop.
- Paste-only for text/URL - rejected, user asked for both paste AND drag-drop support.

## Risks / Trade-offs

- **[Drag-drop accessibility]** → Mitigation: Also provide traditional file picker button in Documents page for keyboard-only users and screen readers. Test with assistive technologies.

- **[PageIndex retrieval quality]** → Mitigation: PageIndex uses reasoning over tree summaries, not similarity search. May be less accurate than vector search for semantic queries but faster, cheaper, no embedding needed. Tune node expansion heuristics based on test queries.

- **[SQLite corruption on crash]** → Mitigation: Single-writer pattern (serialized queue) prevents write contention. WAL mode handles concurrent readers safely. Atomic transactions for status transitions. No temp+rename needed anymore (SQLite itself is atomic).

- **[Better-sqlite3 binary incompatibility on exotic platforms]** → Mitigation: Prebuilt binaries cover darwin/linux x64/arm64 (covers all supported platforms). If builds fail, document manual `npm rebuild better-sqlite3` as setup step. Fallback to `node:sqlite` if available in future Node versions.

- **[LlamaIndex.reader memory usage for large Office docs]** → Mitigation: Set process.memory limit warnings. For very large docs (>10MB), chunk extraction or stream processing may be needed. Monitor heap usage during batch uploads.

- **[Migration from WeKnora data]** → Mitigation: No automatic migration path. Document clearly in README that users must re-ingest docs locally. Keep WeKnora option available long-term (optional configuration) for gradual transition.

## Migration Plan

1. **Foundation**: Create `db.js` schema v1, restore `pageindex-bridge.js` from archived spec, install dependencies (`better-sqlite3`, `pageindex`, `@llamaindex/openai`).

2. **Documents core**: Implement `documents.js` with LlamaIndex settings, readers integration, indexing queue, status broadcasts. Wire up `initStore()` call in server.js startup.

3. **Upload endpoints**: Add `/api/documents/*` REST routes to server.js (POST for add, GET list, DELETE, POST query). Match exact paths from archived implementation.

4. **UI components**: Restore `DocumentsPage.tsx`, update `App.tsx` with `/documents` route, add "Documents" link to `Sidebar.tsx`. Update i18n keys in locale files.

5. **Collections**: Implement `collections.js` module, mount `/api/collections/*` routes after documents routes. Add collections UI tree to left sidebar of Documents page.

6. **Drag-drop handlers**: Restore `onDrop` logic in `Composer.tsx`, remove blocking conditional that previously disabled it. Ensure `documents_status` WS events wired up in `useWebSocket.ts`.

7. **Cleanup**: Remove WeKnora imports from server.js, delete `/api/weknora/*` and `/weknora-web` proxy routes, remove `WEKNORA_*` env vars from `.env.example`. Delete `weknora.js` file.

8. **Testing**: Verify end-to-end flow with sample Office documents, check indexing completes correctly, test query accuracy, confirm drag-drop works across pages, validate graceful degradation when SQLite unavailable.

## Open Questions

- ~~What's the acceptable latency for indexing a 50-page Word doc?~~ **Answer**: Serialized queue means each doc waits its turn. Acceptable if <5 seconds per typical doc; longer docs may timeout. Tune based on testing.
- ~~Should collections support nested hierarchies (subcollections)?~~ **Decision**: Keep flat structure for now. Add hierarchical support later if user feedback demands it. Simpler first iteration.
- ~~Do we need document preview/thumbnails in UI?~~ **Scope**: Out of scope for Phase 1. Focus on upload/query/core features. Thumbnails can be added later if desired.
