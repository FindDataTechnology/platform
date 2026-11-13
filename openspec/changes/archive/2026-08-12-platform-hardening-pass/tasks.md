## Tasks

### Cluster A - Safe mechanical (no behavior change)

#### A1. Wire i18n into DocumentsPage + Composer
- [x] Add `useTranslation()` to `DocumentsPage`, `IngestSection`, `QuerySection`, `CollectionsSection`
- [x] Replace hardcoded literals with `t()` calls mapped to the existing `documents.*` namespace
- [x] Replace `Composer` upload toasts (`:151`,`:153`) with `t("composer.uploaded"/"composer.uploadFailed", {...})`
- [x] Leave URL-example placeholders literal; leave dynamic API error strings (alert messages) as-is
- [x] `npm run check:locales` passes (no new keys added)

#### A2. Add zustand selectors to DocumentsPage consumers
- [x] Import `useShallow` from `zustand/react/shallow`
- [x] `DocumentsPage`: select `documents/loading/selectedDocId/selectedDocContent` via `useShallow`; actions individually
- [x] `QuerySection`: select `docQuery/docAnswer/docQueryLoading` + `setDocQuery/runDocQuery`
- [x] `CollectionsSection`: select `collections/documents` + `load`
- [x] Verify typing in the doc-query input no longer re-renders the doc list

#### A3. Fix cron handlers + async-rejection gaps (server.js)
- [x] Wrap `cron_remove`/`cron_pause`/`cron_resume`/`cron_run` in `try/catch` emitting `{type:"error"}`
- [x] Add `.catch` to connect-time `workdirStore.getWorkdir()` promise (`:798`)
- [x] Wrap `shutdown()` `closeMcpClients` await in `try/catch`
- [x] Wrap `arrayBuffer()` read in `createWebProxy` (`:1714`) with 502 on failure
- [x] Wrap `arrayBuffer()` read in `proxyLitellmUi` (`:1858`) with 502 on failure

#### A4. WS reconnect backoff (useWebSocket.ts)
- [x] Replace fixed 2000ms with exponential backoff `min(30000, 1000*2^attempt)` + jitter
- [x] Add max-retry cap; stop reconnecting after it
- [x] Add `online` event listener for immediate reconnect on wake
- [x] Reset attempt counter on successful `onopen`; preserve `cancelled` unmount guard

### Cluster B - Concurrency gate

#### B1. Fix isStreaming race
- [x] Set `isStreaming = true` synchronously before `await session.prompt()` on the non-steer path (normal prompt branch)
- [x] Same for the skill-invocation branch
- [x] Leave `agent_start` handler's `isStreaming = true` (now idempotent) and `streamedTextThisTurn = false` reset
- [x] Verify a concurrent second prompt now steers instead of racing
- [x] Verify a failed early prompt now broadcasts `done` (no UI wedge)

### Cluster C - Remove baked-in API key

#### C1. Make Volces provider optional
- [x] `server.js:36`: `VOLCES_API_KEY = process.env.VOLCES_API_KEY?.trim()`; add `volcesEnabled`
- [x] `initAgent`: build `agentProviderFactory` only when `volcesEnabled`
- [x] `buildAndBindSession`: `extensionFactories` conditional on `litellmEnabled`/`volcesEnabled` (empty array when neither)
- [x] Add a startup log noting when documents RAG runs without a Volces key
- [x] Update the stale comment in `electron/main.js:71-73` (comment-only)

### Verification
- [x] `node --check server.js`
- [x] `npm run check:locales`
- [x] `npm --prefix web run build` (web type-checks + builds)
- [x] `openspec validate platform-hardening-pass`
- [ ] Manual: two tabs, concurrent prompt -> single turn (steer), not two
  - BLOCKED: only configured provider (Volces) is quota-exhausted (429 until 2026-08-15);
    instant 429s close the race window before a 2nd WS client connects. LiteLLM fallback
    unavailable (LITELLM_API_KEY unset → litellm skipped). Fix verified by inspection
    (isStreaming set synchronously before `await session.prompt()`; single-threaded JS
    cannot interleave two adjacent sync statements). Re-run after quota reset or with a
    working key/model.
- [x] Manual: unset `VOLCES_API_KEY`, `node server.js` starts (no chat provider)
