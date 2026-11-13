# Design: rebuild-knowledge-as-file-library

## Context

The documents module today is a parallel silo next to the dsh chat runtime: its own LLM pipeline (LlamaIndex `Settings` + PageIndex tree building + `llm-chat.js` direct calls to `LLM_BASE_URL`/`LLM_API_KEY` with hardcoded `deepseek-v4-pro`), its own REST query endpoints, and its own page-level QA box. After the single-process refactor the chat runs entirely through dsh; the documents pipeline kept a provider path nobody configures (the Electron shell even ships a placeholder key), so ingest hangs in `indexing` and queries return empty answers. Meanwhile the composer already has an attachment flow (`POST /api/documents` → chip → `@doc:<id>` → `expandDocRefs`), but its expansion reads `source_text`, which the broken pipeline never persists. Existing rails this design rides: `readers.js` local extraction, the `mcp.json` → `dsh-profile.js` patch → `dsh-mcp-client` channel, `better-sqlite3` (FTS5 available), collections tables.

## Goals / Non-Goals

**Goals:**
- Ingest that cannot hang: bounded, local, provider-independent.
- One Q&A surface: the chat window, fed by light attachment context plus agent-invoked retrieval tools.
- Zero new long-running infrastructure: the MCP server is an in-process stdio child owned by the platform server.
- Deterministic retrieval (FTS5) with an interface that can later absorb embeddings without contract change.

**Non-Goals:**
- Embedding/hybrid retrieval, library materialization to workspace disk, and library-wide digests (Phase 3, separate change).
- Multi-user permissions on the library (single-user platform today).
- Preserving `doc_index` trees or migrating them.

## Decisions

### D1. Ingest becomes synchronous local extraction (no queue)

`addDocument` awaits local extraction (readers + `PageIndex.fromPdf`'s page parse is replaced by the existing PDF reader path or pdf-parse-style local parse — no LLM) inside the request, then persists `source_text`, chunks, and marks `ready` before responding. The `queue`/`runIndex`/`emitStatus("indexing")` chain is deleted. The HTTP response returns the terminal status directly, so the UI can never observe a stuck state. A hard byte cap on uploads bounds worst-case parse time.

*Alternative*: keep the queue but make jobs local-only. Rejected — a queue exists to serialize LLM load; with none left it is unobservable state machinery.

### D2. Chunks + FTS5 in the project database

New `document_chunks` FTS5 virtual table (`doc_id UNINDEXED, name UNINDEXED, loc UNINDEXED, text`) written in the same transaction as `source_text`. Chunking: paragraph-split then pack to ~1200 chars with 150-char overlap; `loc` = byte offset of the chunk start in `source_text`. Search uses FTS5 `bm25()` ranking; collection filter joins through the membership table; the LIKE-escape hatch covers CJK terms FTS5's default tokenizer misses (documented limitation; unicode61 tokenizer has no CJK segmentation). Boot-time backfill: for every `ready` doc with `source_text` and zero chunks, chunk+insert; idempotent by construction (delete-then-insert per doc inside one transaction); per-doc try/catch.

*Alternative*: embeddings table + provider calls. Rejected for Phase 2 — reintroduces provider coupling the change exists to remove; the tool interface hides the swap.

### D3. Library MCP server as an in-process stdio child

A small entry script (`server/library-mcp.js`) speaks MCP over stdio (JSON-RPC), importing the same db/search functions the REST layer uses. It is declared in `mcp.json` as `library` (`node server/library-mcp.js`), so the existing `dsh-profile.js` patch machinery mounts it as `mcp__library__list_library` / `search_library` / `read_document` with zero new wiring. Tools: `list_library()` → docs (id, name, type, status) + collections with members; `search_library(query, collection?, doc?, limit≤20)` → ranked hits (doc name, loc, snippet); `read_document(doc_id, cursor?)` → ~8k-char pages with `next_cursor`, error result for unknown/not-ready ids. The child reads the same SQLite file (better-sqlite3 WAL allows concurrent readers with the server's writer).

*Alternative*: register tools through a dsh plugin. Rejected — the MCP channel is already built, configurable, and restartable independently.

### D4. Attachment expansion slims to metadata + tool pointers

`expandDocRefs` stops injecting a 12k source prefix. Per `@doc:<id>` it injects name + first-200-char summary + "full content via mcp__library__read_document / search_library". Collection-started conversations inject one hint block naming the collection and member documents. The user-visible echo keeps raw refs (unchanged).

*Alternative*: keep prefix injection for small docs. Rejected — two code paths, and size thresholds leak; agents read on demand cheaply.

### D5. UI: library page + "Start conversation"

`DocumentsPage` keeps upload/list/preview/delete/collections; the two query sections are deleted with their REST routes (`/api/documents/query`, `/api/collections/:id/query`). New action navigates to `/chat` (existing `new_session` flow) and pre-seeds the composer with refs/hint — implemented as a pending-draft handoff (store field consumed by Composer on mount), not a synthetic user turn. Stuck-state guard: rows non-terminal beyond 30s show a warning chip (belt-and-suspenders; D1 makes terminal states synchronous).

### D6. Dependency removal and data posture

`documents.js` drops `initStore`'s provider config and the LlamaIndex `Settings` block; `pageindex-bridge.js` reduces to extraction helpers or is deleted into `readers.js`. `server.js` drops the documents LLM wiring. `pageindex`, `llamaindex`, `@llamaindex/openai` leave `package.json` (P1 removes imports; the dependency deletion lands with the bundle manifest update). `doc_index` column and existing rows stay untouched one release (rollback = revert code; old pipeline still reads its trees). Restart reconciliation: non-terminal rows from the outage are re-ingested if `source_text` exists, else marked `error` with re-add guidance.

## Risks / Trade-offs

- [FTS5 default tokenizer under-serves CJK queries] → document the limitation; snippets + `read_document` let the agent compensate; Phase 3 can add a custom tokenizer or embeddings behind the same tool.
- [SQLite writer (server) and reader (MCP child) concurrency] → WAL mode (already the project's posture) + short read transactions; the child never writes.
- [MCP child dies mid-conversation] → `dsh-mcp-client`'s existing reconnect/backoff covers it; tool calls fail visibly to the agent, which can tell the user.
- [Large PDF parse blocks the ingest request] → byte cap + parse timeout; error status is a valid terminal outcome.
- [Users lose the page QA box] → intentional (chat is the surface); the "Start conversation" handoff keeps the distance to an answer at one click.

## Migration Plan

1. Deploy P1 (sync ingest, query removal, UI, expansion slim-down). Rollback: revert commit — `doc_index` untouched, old code resumes (stuck rows re-queued as today).
2. Deploy P2 (chunks/FTS5 + MCP server + backfill). Rollback: revert; the FTS table is additive, old pipeline never reads it.
3. After one release in production, a follow-up cleanup change drops `doc_index` and the pageindex/llamaindex dependencies from the bundle manifest.

## Open Questions

- Exact CJK strategy for Phase 3 (custom tokenizer vs embeddings) — deferrable; tool contract unaffected.
- Whether `list_library` should eventually page (library sizes today are tens of docs) — cap at 200 with a truncated marker; revisit if needed.
