## Context

Post-refactor landscape: `server.js` is a composition root; stores share `lib/persistence.js`; CI gates every PR. Measured/derived defects (from static perf pass):
- Boot chain (server.js:2166-2207): middleware → initOpenConnector → chatHistory → workdirStore → db.initDb → documents.initStore → initDshAgent (profile writes sync fs + spawn + up to 20×500ms handshake retries) → runLegacyMigrations → catalog.initCatalog (cloud fetch, 10s AbortSignal) → cron.initCron → **listen**. Nothing answers TCP until all of it.
- RAG (pageindex-bridge.js:111-180): for each ready doc: `selectRelevantNodes` (1 LLM call) then per-doc answer (1 LLM call), sequential; then 1 synthesis call. `db.listReadyDocuments` (db.js:380-387) selects `source_text` for all docs — unused. `getDocIndex` parses full tree JSON per doc per query.
- Static: express.static bare (server.js:1259); web/dist 8.1MB incl. 4.5MB maps; entry 634KB raw; App.tsx:7-17 eager page imports; vite `sourcemap: true`.
- Chat render: useChatStore.apply slices `turns` + mutates tail per delta (useChatStore.ts:86-124); Chat/ChatPage subscribe whole array; AssistantTurn/UserTurn unmemoized. Backend per-message: fresh `db.prepare()` compiles per call (db.js:250-261); `expandDocRefs` SELECT * incl. source_text then slices 12k (server.js:239-255).
- Module load: documents.js statically imports llamaindex + @llamaindex/openai + undici; readers.js pulls mammoth/csv/json-ext/htmlparser2/officeparser; all parsed before :3000 answers.

## Goals / Non-Goals

**Goals:**
- Time-to-TCP-listen ≤ ~1s from process start (static assets + /api/health-class endpoints answer immediately).
- RAG query wall-time ≈ ceil(N/concurrency)×per-doc-cost + synthesis; memory for retrieval no longer includes any `source_text`.
- Wire size for first paint cut by ~70% (gzip + lazy routes); no sourcemaps downloadable from the server.
- Streaming a token costs O(1) component reconciliation (memoized turns) and O(delta) store work (batched commits).
- All wins verifiable: before/after numbers captured in tasks (manual timing + bundle listing; no new bench framework).

**Non-Goals:**
- No embeddings/vector store (architecture decision unchanged: reasoning-based retrieval).
- No worker threads for PDF parsing; no upload streaming (multer memory storage stays; noted as future).
- No transcript virtualization (memoization should suffice at realistic transcript lengths).
- No changes to WS protocol messages beyond an optional readiness state (see D2).

## Decisions

**D1 — Listen-first boot with readiness gate.** New `ctx.ready = { dsh: false, db: false }`. Sequence: construct app/middleware/static → `server.listen` → kick init groups. Route/WS behavior pre-ready: static + `/api/supervisor/status` + `/api/health` (new lightweight endpoint? — reuse supervisor status; add `/api/health` returning 503-until-listen-complete is unnecessary since listening IS health) — decision: no new endpoint; k8s/uptime probes hit TCP+static which now answer instantly. Chat-dependent WS commands (`prompt`, `list_models`, …) and `/api/llm/*`, OC proxies respond `{error: "initializing"}` (HTTP 503, WS `{type:"error", code:"initializing"}`) until `ctx.ready.dsh`. Init groups run via `Promise.all`: [db.initDb → documents.initStore → workdirStore], [initDshAgent], [migrate] — **BUT** migrate depends on db; and documents.initStore's restart-reconciliation should see migrated docs; preserve ordering constraint (spec'd in split-server-monolith): db group completes → (migrate, catalog, cron) in parallel → documents.initStore can start with db but its enqueue reconcile runs after migrate (attach `.then`). Catalog: `initCatalog` returns immediately after loading local `agents.json`; cloud refresh fires un-awaited (existing 60s refresh loop already re-broadcasts changes). dsh handshake retries stay as-is (they no longer block the port). Alternatives rejected: (a) keep order, just parallelize — leaves the 10s catalog + dsh spawn on the critical path; (b) health-gate k8s readiness on full init — couples deploy to dsh availability; static-first is strictly better UX.

**D2 — Readiness signaling to the UI.** Frontend `useWebSocket` already handles `Connected` on open. Add one server-sent initial event when dsh becomes ready post-connect-late: on `connection`, if `!ctx.ready.dsh`, send `{type:"initializing"}`; on ready, broadcast `{type:"ready"}` (client treats as reconnect-lite: re-request models/sessions). Composer disables send while initializing (already disabled pre-`Connected`; extend condition). e2e: existing tests connect after server fully boots (webServer waits for readiness) — no test churn; one new test in `chat-polish.spec.js` asserting the initializing state path is optional — include if cheap.

**D3 — RAG parallelization with bounded concurrency + slim reads + tree cache.**
- `db.listReadyDocuments({ light: true })` → `SELECT id, name FROM documents WHERE status='ready'` (+collection filter as today via collections.js path) — retrieval code uses ids/names only (tree text comes from getDocIndex).
- `mapLimit(docs, RAG_CONCURRENCY=Number(process.env.RAG_CONCURRENCY)||3)` hand-rolled (~10 lines, no dep): per doc `selectRelevantNodes` + per-doc answer remain 2 sequential calls (they're dependent), different docs run in parallel.
- `getDocIndexCached(docId, updatedAt)`: module-level `Map` LRU (cap ~32 entries, prune oldest) in pageindex-bridge; invalidated on `persistIndex` writes. Trees can be large — cap protects memory.
- Synthesis call unchanged. Per-doc failure isolation (knowledge-collection spec) preserved: one doc's LLM failure doesn't abort siblings (existing retry logic stays per-call).
Alternative rejected: full Promise.all (unbounded) — N docs × 2 in-flight LLM calls could starve the gateway; 3 matches the "sequential queue" indexing philosophy already in documents.js.

**D4 — compression + lazy routes + hidden maps.**
- `app.use(compression())` before express.static (filters: default; wasm/brotli fine). Dep: `compression` (tiny, standard). Docker image: no change (node picks up package).
- `App.tsx`: `lazy(() => import("./pages/X"))` for Documents/Extensions/Agents/Models/Embedded views; `Suspense` fallback = existing skeleton/spinner pattern; chat/dashboard stay eager (primary surface).
- `vite.config.ts`: `build.sourcemap: "hidden"` — maps emitted to dist (electron crash reporting can upload them) but no `//# sourceMappingURL` comment → not served/fetchable... note: files still sit in dist and express.static WOULD serve them if requested by exact hashed name. Acceptable? "not referenced" is the standard practice; stricter = `sourcemap: false` for server-served builds. Decision: `false` (simplest, nothing to serve); release builds needing maps can override via env `VITE_SOURCEMAP=hidden` — implement as `sourcemap: process.env.VITE_SOURCEMAP ? "hidden" : false`.

**D5 — Chat render path.**
- `React.memo` on `AssistantTurn`, `UserTurn`, `ToolBlock`, `ThinkingBlock` (identity-stable because the store mutates turn objects in place and only clones the array — verified in useChatStore.ts:124).
- Delta batching: `useChatStore.apply` accumulates `text`/`thinking` deltas in a pending buffer; a `queueMicrotask`/50ms timer flushes one `set()` per batch (order across event types preserved by tagging buffer entries; `turn/end` and non-delta events flush pending first — correctness note: existing e2e `chat-polish` asserts final text and interleaving, must stay green).
- `ChatPage` selector `s => s.turns.length`; `Chat` keeps array subscription (it renders it).
- `Composer` commands memo fix: lift `commands` to module-scope constant (identity stable → existing `useMemo` dep works).

**D6 — SQLite hot path.** db.js: hoist `prepare()` for known statements into a `stmt(name, sql)` lazy registry (first-use compile, cached) — better-sqlite3 prepared statements are reusable and this is its documented best practice. `expandDocRefs` → `db.getDocumentPrefix(id, 12000)` using `substr(source_text, 1, 12000)`. Keep sync calls (better-sqlite3 is sync by design; moving to async workers = architecture change, not this pass).

**D7 — Lazy heavyweight imports.** documents.js: `const { getDocumentReader } = await import("./readers.js")` at extract time; readers.js unchanged internally; pageindex-bridge: `let pageindex; const getPageIndex = async () => pageindex ??= (await import("pageindex")).default;` llamaindex/undici imports move behind first-use functions. Careful: initStore's restart reconciliation path doesn't need them (no re-parse unless re-index); enqueueIndex does. Boot parses ~fewer MB of JS; first document upload pays one-time import (~100–300ms) — acceptable, logged.

## Risks / Trade-offs

- [Parallel init surfaces previously-masked races (e.g. two groups touching dsh-profile files)] → Groups audited: dsh group is sole writer of ~/.dsh files; db group sole opener; catalog read-only at boot (cloud merge after); cron reads db? — cron.initCron moved AFTER db group completes (it broadcasts dashboard state referencing sessions); enforced via group boundaries in tasks.
- [Lazy imports change failure timing (broken dep discovered at first upload, not boot)] → CI e2e documents specs exercise the real path (upload+index with stub LLM), catching it in PRs.
- [Batching deltas changes perceived latency if flush window too coarse] → 50ms ≈ under a frame budget at 60fps×3; e2e + manual check on smoke run; tunable constant.
- [compression on already-brotli'd wasm / large PDFs served from memory] → compression middleware skips pre-compressed via Content-Encoding check; PDF API responses are JSON metadata (source text JSON could be large — compressible, fine).
- [`React.memo` masks state bugs if turns are replaced rather than mutated] → Verified store strategy (in-place mutation); add a unit assertion in test-chat-store-rename style if cheap.
- [Sourcemap `false` hurts production debugging] → Env override documented; release builds may set VITE_SOURCEMAP=hidden and strip maps from the served copy.

## Migration Plan

Backend and frontend halves land independently: (1) db.js prepared statements + substr (pure win, zero risk); (2) compression + lazy routes + sourcemaps; (3) RAG parallel + light select + cache; (4) render memoization + batching; (5) listen-first boot last (touches lifecycle, highest blast radius, lands on top of greenest tree). Each step e2e-fast verified; PR captures before/after numbers (boot time to first byte, bundle listing, RAG query time with 3 stub docs). Rollback: per-step revert; no data/config migrations.

## Open Questions

- None blocking. Optional future: `/api/health` readiness semantics for k8s (D1) if deployment ever needs deeper-than-TCP probes; worker-thread indexing if doc volume grows.


## Implementation Notes (2026-08-29)

- D1 amended: a `/api/ready` endpoint was added despite the "no new endpoint" lean — the e2e webServer previously gated readiness on the PORT, which listen-first would open before the agent; url-based readiness on /api/ready preserves the suite's half-booted-race protection and gives deploy probes a deeper-than-TCP signal. The playwright webServer now uses `url` (this Playwright build rejects url+port together).
- D2 partially implemented server-side only: mid-boot WS connections receive `{type:"initializing"}` and gated commands answer an error; on ready every connected client gets the ready event + the full connect-time payload sync (models/sessions/agents/current_model). No Composer changes were needed — the e2e suite never exercises the window (it gates on /api/ready) and the store's data-driven UI enables itself when the ready payload lands. A dedicated initializing-state UI test remains future work.
- catalog local-first (D1) surfaced a real spec assumption: auth-catalog's raw-WS tests expected cloud entries at connect. The spec now polls list_agents/fetch until the async merge lands; waitFor gained async-predicate support (a raw Promise is truthy and exited its loop instantly).
- The two ready-doc light selects had escaped the change-1 statement cache via a multiline `db\.prepare(` form — fixed here alongside the source_text removal.
