## 1. Low-risk backend wins (land first, independent)

- [x] 1.1 db.js: lazy prepared-statement registry — hoist the per-call `db.prepare()` compiles (messages append/list, sessions, documents get/upsert) to cached statements; verify with unit tests + e2e fast
- [x] 1.2 db.js: add `getDocumentPrefix(id, n)` using `substr(source_text,1,n)`; `expandDocRefs` switches to it (keeps the 12,000-char slice semantics, now at SQL level); commit
- [x] 1.3 Record baseline numbers in PR notes: boot time to first byte, `du -sh web/dist` + entry chunk size, RAG query time with 3 stub docs

## 2. Transport & bundle

- [x] 2.1 Add `compression` dependency; `app.use(compression())` before express.static; verify gzip on entry chunk via curl `--compressed -I` (Content-Encoding present) and no behavior change for API JSON
- [x] 2.2 `App.tsx`: `React.lazy` + `Suspense` for Documents/Extensions/Agents/Models/Embedded pages (chat + dashboard stay eager); verify each route loads and nav-persistence/nav-routes e2e specs pass; record new entry-chunk size
- [x] 2.3 `vite.config.ts`: `sourcemap: false` by default with `VITE_SOURCEMAP=hidden` env override; confirm dist contains no maps in default build; commit

## 3. RAG retrieval path

- [x] 3.1 db.js: `listReadyDocuments` light variant selecting `id, name` only (+ collection filter); pageindex-bridge retrieval path switches to it
- [x] 3.2 pageindex-bridge: `getDocIndexCached` LRU (cap 32, key `docId:updatedAt`), invalidated in `persistIndex`; unit-check via existing documents e2e + a manual double-query log assert
- [x] 3.3 pageindex-bridge: hand-rolled `mapLimit` (default `RAG_CONCURRENCY=3`, env-overridable) around per-doc select+answer; keep per-doc retry and failure isolation; verify collections/documents query e2e specs; record before/after query wall-time with 3 docs; commit

## 4. Chat render path (frontend)

- [x] 4.1 `React.memo` on AssistantTurn, UserTurn, ToolBlock, ThinkingBlock; ChatPage selector → `turns.length`; Composer `commands` lifted to module-scope constant; tsc + e2e chat-polish green
- [x] 4.2 useChatStore: batch `text`/`thinking` deltas (~50ms flush, order-preserving across event types, flush-before `turn/end` and non-delta events); verify chat-streaming/chat-polish e2e and one long-response smoke check; commit

## 5. Listen-first boot (last, highest blast radius)

- [x] 5.1 Restructure boot: middleware + static + `server.listen` first; init groups via Promise.all — [db → workdir] → then [migrate, catalog(local-first), cron] parallel; dsh group independent; documents.initStore reconcile chained after migrate (preserve ordering invariant)
- [x] 5.2 Readiness gating: `ctx.ready.dsh`; chat-dependent WS commands and `/api/llm/*` + OC routes return 503/WS `initializing` error until ready; on ready broadcast `{type:"ready"}`; on connect during init send `{type:"initializing"}`; frontend: Composer disabled while initializing, re-fetch models/sessions on ready
- [x] 5.3 catalog.js: `initCatalog` resolves on local load; cloud fetch un-awaited (existing refresh loop merges + broadcasts on arrival); verify agents-tabs/auth-catalog e2e
- [x] 5.4 Lazy heavyweight imports: documents.js/readers.js/pageindex-bridge dynamic-`import()` llamaindex/openai-readers/undici/pageindex at first use; confirm boot no longer parses them (log module-load timing before/after); documents upload+index e2e still green
- [x] 5.5 Full gate run green (final numbers vs baseline: boot — port listening at 0.67s + agent ready at 2.3s warm-probe vs port-last before (cold-start incl. 10s catalog timeout previously ~50s+, now overlapped); wire — entry chunk 566,242B → 176,539B gzip (−69%), route-split chunks out of the entry; RAG — per-doc LLM calls bounded-concurrent (3) + trees cached + no source_text loads; render — one commit per 50ms delta window, memoized turns; e2e 95 passed / 1 skipped / 0 failed in 1.4m) (lint, typecheck, unit, locales, web:build, e2e fast); capture final numbers vs baseline in PR (boot-to-first-byte, wire bytes first paint, RAG query time, dist size)
