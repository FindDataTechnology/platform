## Why

Persistence logic is hand-rolled per module with diverging safety levels: 8 independent temp+rename "atomic write" implementations (no fsync anywhere), ~6 "read JSON with fallback" helpers with different error styles, three separate JSON-collection CRUD cycles (llm-providers, cron jobs, workdirs), duplicated micro-helpers (`toIso`, `truncateTitle`, `normalizeBaseUrl`), and inconsistent IDs/timestamps per module. One defect is concrete: `cron.js` has NO write lock — concurrent `addJob`+`removeJob` both write the same `jobs.json.tmp` path, which can corrupt or lose the jobs file (llm-providers has an in-process lock in server code; chat-history has per-id locks; cron has nothing). Third of four sequenced optimisation changes — lands after the server split so the write paths live in small modules.

## What Changes

- New shared module `lib/persistence.js` (repo-root `lib/`, new directory):
  - `atomicWriteJson(path, value)` / `atomicWriteText(path, text)` — temp+rename WITH fsync of file (and best-effort dir fsync), unique temp suffix (`${path}.${process.pid}.${randomUUID()}.tmp`) eliminating the shared-tmp-path race class
  - `readJsonOr(path, fallback)` — ENOENT → fallback; parse error → warn + fallback (single consistent policy)
  - shared `nowIso()` (re-export of db.js's), `newId()` (crypto.randomUUID), `truncateTitle()`
- Migrate all 8 write sites + 6 read sites to the helpers (llm-providers.js, workdir-store.js, cron.js, dsh-profile.js ×4, skill-materialize.js, catalog.js, extension-store.js ×2, bootstrap/first-run.js) — byte-identical output formatting (`JSON.stringify(v, null, 2)` / `yaml.dump`), zero on-disk format change.
- Add a serialized write queue per store file (a ~15-line `createFileStore` wrapper providing load/lock/save) used by cron.js, llm-providers.js, and workdir-store.js; removes the cron race and lets the in-process `withLlmWriteLock` live next to its data instead of server route code.
- Delete dead code: `chat-history.js` `toIso` (unused), duplicated `truncateTitle` in migrate.js (import shared), keep `normalizeBaseUrl` duplication only if the import-cycle comment still holds — otherwise consolidate.
- **Explicitly deferred** (documented, not done): moving jobs.json/workdirs/llm-providers.json into SQLite. jobs.json is currently `[]`, so a later import is nearly free; dsh hot-reload requires settings.yaml/.credentials.yaml at exact paths regardless.

## Capabilities

### New Capabilities
- `file-persistence`: contract for durable JSON/YAML file persistence — atomicity (temp+rename+fsync), unique temp paths, single read-fallback policy, per-store serialized writes, and shared id/timestamp helpers.

### Modified Capabilities
(none — on-disk formats, file paths, and all externally observable behavior of existing stores are unchanged; existing specs continue to hold.)

## Impact

- **Files**: new `lib/persistence.js` (+ unit tests `scripts/test-persistence.mjs`); edited: `llm-providers.js`, `workdir-store.js`, `cron.js`, `dsh-profile.js`, `skill-materialize.js`, `catalog.js`, `extension-store.js`, `bootstrap/first-run.js`, `chat-history.js` (dead code), `migrate.js` (helper import); `server/routes/llm.js` (post-split) loses `withLlmWriteLock` to the store wrapper.
- **Behavior deltas (intentional, narrow)**: (1) cron mutations can no longer interleave — a concurrent add/remove becomes sequential instead of racing; (2) corrupt JSON files now warn-and-fallback consistently instead of the current mixed warn/silent/crash-by-store; (3) durability improves (fsync) — no API/route/WS changes.
- **Risk**: low — output bytes identical, paths identical, dsh-watched files keep exact layouts; 96 e2e tests + unit tests (including new persistence tests) cover CRUD flows for cron/extensions/llm-providers.
