## 1. Shared module

- [x] 1.1 Create `lib/persistence.js`: atomicWriteJson/Text (+Sync variants, shared temp-write core, unique temp suffix `${pid}-${uuid8}.tmp`, fsync file + best-effort dir fsync), readJsonOr (single fallback policy with `label` log prefix), nowIso/newId/truncateTitle re-exports; JSDoc: prefer async variants
- [x] 1.2 Create `scripts/test-persistence.mjs` (node:test, tmpdir): exact-bytes write, no tmp leftovers, concurrent saves distinct temp paths, readJsonOr fallback on missing/corrupt, mutate-queue no-lost-update; wire into `test:unit` glob if needed

## 2. Migrate stores (order: riskiest fix first)

- [x] 2.1 cron.js: adopt `createFileStore` wrapper (promise-chain serialized mutate) for addJob/removeJob/pauseJob/resumeJob/saveJobs — eliminates the jobs.json.tmp race; keep node-schedule handle stripping; run dashboard/cron e2e specs, commit
- [x] 2.2 llm-providers.js: readJson/writeJsonAtomic → shared helpers; mutations via store wrapper; remove `withLlmWriteLock` from route code (first verify no e2e asserts 409-on-contention; if one does, add nonblocking `tryMutate` instead); run llm-models e2e specs + `scripts/test-llm-providers.mjs`, commit
- [x] 2.3 workdir-store.js: shared helpers + store wrapper (keeps dirty-flag coalescing semantics); commit
- [x] 2.4 dsh-profile.js: swap the 4 writeFileSync+rename sites to `atomicWriteTextSync` (keep compare-before-write mtime guards, 0600 chmod after rename, ref-pruning, merge-preserve); golden-file test comparing YAML output before/after for a fixture profile; commit
- [x] 2.5 skill-materialize.js + catalog.js + extension-store.js (market readers) + bootstrap/first-run.js: shared read/write helpers, preserving each site's log labels via the `label` option; commit

## 3. Dedupe + closeout

- [x] 3.1 Remove dead `toIso` (chat-history.js:98-104); migrate `truncateTitle` (chat-history.js, migrate.js) and `normalizeBaseUrl` (llm-providers.js ↔ dsh-profile.js — route through `lib/` to break the stated import cycle) to single homes; run `npm run test:unit`
- [x] 3.2 Grep `scripts/`, `Dockerfile`, `.github/` for `\.tmp` glob dependencies on the old fixed sibling name; confirm unique-suffix names still match
- [x] 3.3 Full gate run (lint, typecheck, unit, locales, web:build, e2e fast) green; document in PR: deferred decision to keep JSON stores (vs SQLite) and the future jobs.json import path
