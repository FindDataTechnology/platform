# Tasks: rebuild-knowledge-as-file-library

## 1. Phase 1 — Local ingest (server)

- [x] 1.1 Rewrite `documents.js#addDocument` to extract text synchronously via `readers.js` (add a local PDF text-extraction path if the reader set lacks one), persist `source_text`, and return terminal status (`ready`/`error`) in the response; delete the `queue`/`runIndex` chain and `emitStatus("indexing")`. Verify: upload a `.md`/`.txt`/`.pdf` via `POST /api/documents` and observe `ready` (or a specific `error`) in the response body with no LLM process calls.
- [x] 1.2 Remove the provider wiring: `initStore`'s `baseUrl`/`apiKey`/`model` params, the LlamaIndex `Settings` block, `DOCUMENTS_MODEL`, and `server.js`'s documents-side `LLM_API_KEY` warning/init coupling. Verify: server boots with no LLM env set; upload/list/view/delete round-trip green in a manual curl pass.
- [x] 1.3 Reduce `pageindex-bridge.js` to the extraction helpers actually used (fold into `readers.js` or delete); remove `llamaindex`/`@llamaindex/openai` imports project-wide. Verify: `grep -r "llamaindex\|pageindex" --include="*.js" server* lib` returns no runtime imports; server boots and ingests.
- [x] 1.4 Startup reconciliation: non-terminal rows re-ingest from `source_text` when present, else flip to `error` with re-add guidance. Verify: seed a `queued` row with `source_text` in SQLite, restart, observe `ready`; seed one without, observe `error` + message.
- [x] 1.5 Remove query routes `POST /api/documents/query` and `POST /api/collections/:id/query` plus `queryCollection`/`queryCollectionDocuments` and `pageindex-bridge` retrieval code. Verify: routes 404, no dead exports remain, server boots clean.

## 2. Phase 1 — Chat-side integration

- [x] 2.1 Rewrite `expandDocRefs` in `server/skills.js` to inject per-doc light context (name, 200-char summary, tool pointers to `mcp__library__read_document`/`search_library`) with an explicit unavailability note for contentless ids; add the collection-hint block builder used by conversation starts. Verify: unit-level check via a seeded doc — expanded prompt contains summary + tool names and no source-text body.
- [x] 2.2 Add the composer draft handoff: store field (e.g. `pendingDraft`) set by the library page, consumed and cleared by Composer on mount. Verify: navigate from library with refs → composer pre-filled; sending works; field clears after consume and after session switches.
- [x] 2.3 `DocumentsPage`: delete both query sections and their state; add per-file and per-collection "Start conversation" buttons wiring to 2.2 (file → `@doc:<id>` refs; collection → collection hint). Verify: `e2e` click-through opens `/chat` with the seeded draft and a sendable prompt.
- [x] 2.4 Stuck-state guard: rows non-terminal >30s render a warning chip. Verify: e2e seam injects a fake `queued` row and clock-advance shows the chip.
- [x] 2.5 Locales: remove query strings, add "Start conversation"/warning keys across all 5 bundles. Verify: `npm run check:locales` passes and no orphan keys remain.

## 3. Phase 2 — Search index

- [x] 3.1 Add `document_chunks` FTS5 table + chunker (~1200-char paragraphs, 150 overlap, byte `loc`) writing in the ingest transaction; delete chunks on document delete. Verify: upload produces chunk rows; delete leaves none.
- [x] 3.2 Search function over FTS5 (`bm25` ranking, collection/doc filters, empty-result success) in a shared module usable by both server and the MCP child. Verify: seeded multi-doc search returns ranked hits with names + locs; no-match returns `[]`.
- [x] 3.3 Boot-time idempotent backfill for `ready` docs with `source_text` and zero chunks, per-doc failure isolation. Verify: startup on a legacy DB creates chunks once; second startup is a no-op (row count unchanged).
- [x] 3.4 e2e: upload → search hit; delete → no hit; backfill idempotence via double-boot fixture. Verify: new spec passes in the fast project.

## 4. Phase 2 — Library MCP server

- [x] 4.1 Implement `server/library-mcp.js` (stdio JSON-RPC): `list_library`, `search_library` (limit≤20), `read_document` (~8k pages, cursor; error result for unknown/not-ready). Reads only; WAL-friendly short transactions. Verify: drive the child over stdio with a script — three tools return contract-shaped results.
- [x] 4.2 Register `library` in `mcp.json`; confirm `dsh-profile.js` patch picks it up (tool names `mcp__library__*`). Verify: boot server, `list_skills`-style probe or DSH_DEBUG log shows the three tools mounted; chat turn invoking a tool returns real content.
- [x] 4.3 Failure posture: MCP child crash does not block chat startup (client reconnect path), logged once. Verify: kill the child mid-session; next turn surfaces a tool error to the agent, chat stays alive, child restarts per client policy.
- [x] 4.4 e2e: tool-contract retrieval (adjusted from the original agent-answer form). The hermetic fast project has no live LLM, so an agent-authored answer cannot be asserted there; the spec instead drives the REAL ingest + the MCP child over stdio and asserts search/read/list/error contracts end to end (`e2e/library-tools.spec.js`), plus the library-page handoff spec seeds a collection-started conversation. Full agent-visible retrieval stays covered by the live project.

## 5. Cleanup & release

- [x] 5.1 Remove `pageindex` (and now-unused transitive deps) from `package.json`; rebuild bundle manifest; `predist` verify passes. `doc_index` column stays this release.
- [x] 5.2 Full gate: unit tests 66/66, web typecheck clean (pre-existing `settings/` errors aside), full fast e2e 172 passed / 1 skipped / 0 failed, biome clean on every file this change touched (repo-wide biome carries ~170 pre-existing errors from prior uncommitted work, untouched here), `verify-bundle` OK. Spec sync + archive remain for the archive step (`/opsx:archive`-equivalent) once reviewed.
