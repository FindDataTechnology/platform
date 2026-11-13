# Proposal: rebuild-knowledge-as-file-library

## Why

The knowledge module is unusable: uploads sit in "indexing" forever and questions return empty answers. Root cause: after the single-process platform refactor (dsh runtime), the documents module kept a private LLM pipeline (LlamaIndex + PageIndex tree building + Volces direct-connect + hardcoded `deepseek-v4-pro`) that no longer receives a working provider — and its silent-failure design (HTTP 200 with empty answer; no indexing timeout) hides the break. The desired UX is also different: files should feed conversations in the main chat window, not a page-level query box.

## What Changes

**Phase 1 — library foundation (stops the bleeding)**
- Upload becomes fully local: extract text (existing readers + PDF parse), persist `source_text`, status goes `queued → ready` in seconds. Zero LLM calls during ingest.
- **BREAKING**: remove the page-level query box (collection-wide and per-collection RAG query) — the chat window becomes the only Q&A entry.
- **BREAKING**: remove the PageIndex/LlamaIndex indexing pipeline and the Volces `LLM_API_KEY`/`DOCUMENTS_MODEL` coupling; `doc_index` trees stop being written or read (table retained one release for rollback).
- File and collection cards gain a "Start conversation" action: opens a new chat session with the file `@doc:` refs (single file) or a collection hint (collection) pre-attached.
- Attachments inject light context: document metadata + summary + a pointer to the library tools instead of a 12k source-text prefix.

**Phase 2 — agent retrieval tools**
- Chunk `source_text` at ingest into an SQLite FTS5 index (local, deterministic, no embedding dependency).
- The platform exposes an in-process MCP server (via the existing `mcp.json` → `dsh-mcp-client` channel) with three tools: `list_library`, `search_library` (lexical, collection/doc filterable), `read_document` (paged full text).
- Idempotent boot-time backfill chunks existing `source_text` rows.

**Phase 3 — optional depth (not in initial implementation)**
- Embedding-based hybrid retrieval behind the same tool interface; library materialization to disk.

## Capabilities

### New Capabilities
- `document-search-index`: local chunk + FTS5 search index over library documents — ingest-time chunking, boot-time backfill, lexical search behavior.
- `document-library-tools`: the agent-facing MCP tool surface (`list_library`, `search_library`, `read_document`) including naming, filters, paging, and failure contract.

### Modified Capabilities
- `document-management`: ingest requirements change — local extraction with immediate readiness replaces the LLM indexing queue; LLM provider coupling removed.
- `document-management-ui`: the knowledge page becomes a file library (upload/list/preview/delete/collections + "Start conversation"); query-interface requirements removed.
- `chat-attachments`: `@doc:` expansion slims to metadata + tool hints; no full source-text prefix injection.
- `document-collections`: collections become chat-starting groups and tool filters; RAG-scope query requirements removed.
- `pageindex-storage`: all requirements removed (pipeline deleted; superseded by `document-search-index`).

## Impact

- **Server**: `documents.js` (queue → local extraction), `pageindex-bridge.js` (deleted or reduced to readers glue), `readers.js` (retained), `server/routes/documents.js` (query routes removed), `server/skills.js` (`expandDocRefs` rewrite), `server.js` (drop `LLM_API_KEY`/Volces wiring for documents), new in-process MCP server module.
- **Web**: `DocumentsPage.tsx` (library + start-conversation), `Composer.tsx` (unchanged chip flow), `locales/*` (query strings removed, new action strings).
- **Dependencies**: `pageindex` (+ its OpenAI client usage) becomes removable; `llamaindex`/`@llamaindex/openai` imports removed.
- **Data**: `documents.source_text` retained and authoritative; `doc_index` orphaned (kept one release); new `document_chunks` FTS5 table.
- **Existing behavior**: uploads during the outage that never reached `ready` are marked error on restart with source-text-preserved re-add guidance.
