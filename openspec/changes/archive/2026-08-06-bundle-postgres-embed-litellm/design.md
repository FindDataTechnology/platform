## Context

The bundled LiteLLM proxy (litellm 1.53.9, in `resources/litellm/venv`) runs in "proxy-only" mode: it has a `master_key` + `model_list` (in `litellm.yaml`) but **no database**. litellm 1.53.9 requires a **Postgres** database for its admin UI - its Prisma schema (`litellm/proxy/schema.prisma`, `provider = "postgresql"`) uses the `Json` type in 35 places, and Prisma's SQLite connector rejects `Json` (confirmed: 35 validation errors), so SQLite is not an option. Without a DB the admin dashboard shows "Missing Environment Variables: DATABASE_URL, LITELLM_MASTER_KEY", and the `litellm-web` spec deliberately links out to a new tab (no iframe) because the dashboard can't initialize and has an interactive sign-in.

The project already bundles three supervisor-managed services for the DMG/EXE - Node (`resources/node`, `scripts/build-node.js`), Python+LiteLLM venv (`resources/litellm`, `scripts/build-python-litellm.js`), OpenConnector (`resources/openconnector`, `scripts/build-openconnector.js`) - each cross-platform, skip-if-built, downloaded with `curl`+`tar`, and packaged via `electron-builder.yml` `extraResources`. The supervisor (`supervisor/descriptors.js` + `lifecycle.js`/`health.js`/`ports.js`/`process.js`) spawns them, assigns free ports, health-checks, and restarts/stops them; `bootstrap/first-run.js` seeds first-run state (tokens, `LITELLM_API_KEY`, `litellm.yaml`, venv relocation) into `PLATFORM_DATA_DIR` (`paths.js` `storeDir()`). The release CI (`.github/workflows/release.yml`) is a 3-entry matrix (macos arm64, macos x64 via Rosetta, windows x64) where each runner runs `npm run predist` (build scripts auto-detect platform/arch) then `npm run dist -- --${arch}`.

Agent research confirmed:
- **Postgres source**: `@embedded-postgres/darwin-arm64` + `@embedded-postgres/windows-x64` npm tarballs (`17.10.0-beta.17`) ship prebuilt, relocatable Postgres 17.10 binaries (bin/lib/share) **inside the tarball** (no install-time download), with npm-published SHA512 integrity. The mac binaries are **universal** (one tarball covers arm64 + x64). Unpacked ~135 MB mac / ~102 MB win. Redistributable (PostgreSQL License). Lacks `pg_isready` (TCP-poll the port instead). EDB binary zips are a fallback (no checksums, 3x larger).
- **Prisma**: litellm's `proxy` extra does NOT pull `prisma`. `prisma generate --schema=<litellm schema>` is required (downloads the platform query-engine + generates the Python client). The engine must be copied to a stable venv path (`<venv>/prisma-engine/query-engine`) because the generated client bakes the build-time absolute path. **Critical**: litellm runs `subprocess.run(["prisma","db","push"])` at startup, and `prisma` internally runs `node` - so the LiteLLM child env must prepend `<venv>/bin` + bundled `<node>/bin` to `PATH`, and set `PRISMA_QUERY_ENGINE_BINARY`. The admin UI checks `LITELLM_MASTER_KEY` (not the top-level `master_key` in yaml), and `LITELLM_SALT_KEY` (must be generated once + never change).

## Goals / Non-Goals

**Goals:**
- Ship a bundled, supervisor-managed Postgres in the DMG (arm64+x64) and EXE (x64) that other bundled services can use.
- Make the LiteLLM admin UI initialize and be embeddable in-app (Prisma + DB + master/salt keys + PATH).
- Replace the LiteLLM "open-in-new-tab link" with an in-page embedded dashboard via `/litellm-web`.
- Preserve existing graceful-degradation (Postgres + LiteLLM-DB are optional; a failure doesn't block the app).

**Non-Goals:**
- Running Postgres as a system service / on a fixed port (it's a per-user bundled instance on a free port).
- Multi-tenant / remote Postgres (the bundled instance is for the bundled LiteLLM only; remote LiteLLM still works via `LITELLM_BASE_URL`).
- Replacing the documents RAG's SQLite (`project-database`) - that stays SQLite.
- A full LiteLLM model CRUD via the UI when OpenConnector is enabled (the `/v1/*` `/api/*` proxy conflict with OC means some dashboard endpoints won't work in the iframe; model management is via `STORE_MODEL_IN_DB` + the DB).

## Decisions

### D1: Source Postgres from `@embedded-postgres/*` npm tarballs
`scripts/build-postgres.js` mirrors `scripts/build-node.js`: detects platform (mac arm64/x64 -> `@embedded-postgres/darwin-arm64`; win x64 -> `@embedded-postgres/windows-x64`), curls the tarball from `registry.npmjs.org`, verifies SHA512 against the registry's `dist.integrity`, extracts `package/native/` -> `resources/postgres/` (flatten the `package/` prefix), `chmod +x` mac binaries, skip-if-built. Pin `17.10.0-beta.17` in `package.json` `platformBundles.postgresVersion`. The mac tarball is universal, so both mac CI jobs download the same archive (no Rosetta issue). The binaries are relocatable (postgres auto-resolves `../lib`/`../share`), so `resources/postgres/{bin,lib,share}` (read-only in the bundle) + a writable data dir in `PLATFORM_DATA_DIR` works.
- *Alternative*: EDB `postgresql-17.10-1-{osx,windows-x64}-binaries.zip` - rejected (3x larger, no published checksums, more to strip).

### D2: Postgres as a new supervisor service (`kind: "postgres"`)
Add a `postgres` descriptor to `supervisor/descriptors.js`. Lifecycle:
- **First run**: if the data dir (`storeDir("postgres-data")`) doesn't exist, run `initdb -D <dataDir> --auth=trust -U postgres` (trust auth - localhost-only, free port; no password to manage). Done in the supervisor's start path (or `bootstrap/first-run.js`) - idempotent.
- **Start**: `pg_ctl -D <dataDir> -o "-p <freePort> -c listen_addresses=localhost" -w start` (the `-w` waits for ready; on Windows `pg_ctl.exe`).
- **Health**: TCP-poll `127.0.0.1:<port>` (no `pg_isready` in embedded-postgres); mark healthy on connect.
- **Stop**: `pg_ctl -D <dataDir> -m fast -w stop`.
- **DB creation**: after start, `createdb -p <port> -U postgres litellm` (or `psql -c 'CREATE DATABASE litellm'`) if not exists - idempotent.
The supervisor assigns a free port (ports.js) and starts postgres before LiteLLM (LiteLLM `dependsOn: ["postgres"]`). `bootstrap/first-run.js` gains `hasBundledPostgres = exists resources/postgres/bin/postgres` detection.
- *Alternative*: run initdb in `bootstrap/first-run.js` (separate from supervisor). Rejected - keep the supervisor the single owner of child lifecycle; initdb-on-first-start is the standard embedded-postgres pattern.

### D3: Prisma in the bundled LiteLLM venv
In `scripts/build-python-litellm.js`, after `pip install litellm[proxy]`:
1. `pip install prisma==0.11.0` (litellm's stated `extra-proxy` pin; 0.15.0 also works).
2. Set `PRISMA_BINARY_CACHE_DIR=<venv>/prisma-cache` + `PRISMA_USE_GLOBAL_NODE=true` (engine lands inside the venv -> bundled).
3. `<venv>/bin/prisma generate --schema=<venv>/lib/python3.13/site-packages/litellm/proxy/schema.prisma` (Windows: `Scripts/prisma.exe`). Generates the Python client into `site-packages/prisma/` (bundled) + the query-engine into the cache.
4. `find <cache> -name "query-engine-*"` -> copy to `<venv>/prisma-engine/query-engine` (stable path; the generated client bakes build-time absolute paths, so a stable runtime path is required).
`scripts/verify-bundle.js` asserts `resources/postgres/bin/postgres` + `<venv>/prisma-engine/query-engine` exist.

### D4: LiteLLM child env wiring (the critical runtime fix)
`supervisor/descriptors.js` LiteLLM descriptor `env` gains:
- `DATABASE_URL=postgresql://postgres@localhost:<pgPort>/litellm` (set after postgres starts; litellm appends pool params).
- `LITELLM_MASTER_KEY=<LITELLM_API_KEY>` (the admin UI checks this env name, not the yaml top-level `master_key`).
- `LITELLM_SALT_KEY=<generated once, persisted>` (from `bootstrap/first-run.js` - `crypto.randomBytes(32).toString("hex")`, stored in settings.json; **never regenerated** - changing it orphans encrypted DB values).
- `STORE_MODEL_IN_DB=True` (so the UI can CRUD models in the DB).
- `PRISMA_QUERY_ENGINE_BINARY=<resourceRoot>/litellm/venv/prisma-engine/query-engine`.
- `PATH=<resourceRoot>/litellm/venv/bin:<resourceRoot>/node/bin:$PATH` (so litellm's `subprocess.run(["prisma",...])` finds `prisma` and `prisma`'s internal `node` finds `node`). On Windows: `Scripts` + `node` + `%PATH%`.
`SETTING_KEYS` (`local-services.js` + `electron/config/settings.js`) gains `DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`. When postgres is external (user sets `DATABASE_URL`), the bundled postgres is skipped (mirror the OC/LiteLLM external-override pattern).

### D5: Embed the LiteLLM dashboard in-page via `/litellm-web`
Revert the `litellm-web` "no iframe, open in new tab" requirement (now feasible with a DB). Changes in `server.js`:
- Proxy `/ui/*` -> LiteLLM `/ui/*` (token-injected `LITELLM_API_KEY`) so the dashboard's Next.js assets (`/ui/_next/...`) load; add `/ui/` to the SPA-fallback exclusion regex (`^\/(?!api\/|oc-web|litellm-web|assets\/|v1\/|ui\/).*`).
- Keep the existing `/litellm-web` + `/key/*` `/spend/*` `/model/*` LiteLLM proxies (the dashboard's admin API roots).
- `LiteLLMPage` (`web/src/pages/EmbeddedServicePages.tsx`) renders `<EmbeddedFrame src="/litellm-web/ui" />` (same as OpenConnector) instead of the open-in-new-tab link. Drop the master-key/API-URL copyable fields (the dashboard sign-in uses the master key; keep `apiBaseUrl` in `/api/config` for direct API use).
- **Known limitation**: the dashboard's `/v1/*` and `/api/*` calls conflict with OpenConnector (OC owns those when enabled). With OC enabled, dashboard features that hit `/v1/models` won't work in the iframe; model management goes through `STORE_MODEL_IN_DB` + the DB. Acceptable - the primary use is model/key/user admin via the DB, not the `/v1/models` view.
- *Alternative*: keep the new-tab link. Rejected - the user explicitly wants in-page embedding now that a DB makes it functional.

### D6: macOS codesigning for the bundled Postgres binaries
The postgres binary + `lib/postgresql/*.dylib` are unsigned. For a notarized app (Hardened Runtime), every executable/dylib must be signed with the app's identity. Add a post-build (or `electron-builder` `afterPack`) hook that `codesign --options runtime --sign $APP_PATH` the postgres binaries + dylibs on mac, mirroring how the bundled Node is handled. When signing secrets are absent (unsigned build), skip - the app still runs (Gatekeeper warning only).

### D7: OpenSpec + CI
This change adds `postgres-bundle` capability + modifies `desktop-supervisor`, `litellm-web`, `litellm-provider`. CI (`.github/workflows/release.yml`): adding `node scripts/build-postgres.js` to `predist` handles all 3 matrix targets automatically (build-postgres.js auto-detects platform/arch like build-node.js; the prisma generate in build-python-litellm.js runs per-platform on each runner). `electron-builder.yml` `extraResources` gains `resources/postgres/ -> postgres/`. `package.json` `platformBundles.postgresVersion` + `predist` updated.

## Risks / Trade-offs

- **[Bundle size]** +~135 MB mac / ~102 MB win per installer (Postgres binaries) + the prisma engine (~40 MB) in the venv. -> Mitigation: the `@embedded-postgres` tarballs are already minimal (no `pg_dump`/`psql`/`pgbench`); acceptable for a desktop app that needs a DB.
- **[Prisma PATH fragility]** litellm shells out to `prisma` + `node` at startup; if `PATH` isn't prepended correctly per-platform, the DB silently doesn't initialize ("prisma package not found"). -> Mitigation: `verify-bundle.js` asserts the engine path; the supervisor sets `PATH` explicitly; add a startup log in `server.js`/supervisor when `litellmEnabled` but the DB health check fails.
- **[LITELLM_SALT_KEY immutability]** if the salt key is regenerated, all encrypted DB values are undecryptable. -> Mitigation: generate once in `bootstrap/first-run.js`, persist to settings.json, never overwrite (the first-run already follows this pattern for `LITELLM_API_KEY`).
- **[Embedding `/v1/*` `/api/*` conflict]** the dashboard's `/v1/*` `/api/*` calls go to OpenConnector when OC is enabled, so some dashboard views are broken in the iframe. -> Mitigation: documented limitation; model management via `STORE_MODEL_IN_DB`. If critical, a future change could proxy `/litellm-web/v1/*` distinctly (complex).
- **[mac codesigning]** unsigned postgres binaries may fail notarization. -> Mitigation: D6 signs them; unsigned builds still run (warning only).
- **[First-run initdb latency]** adds a few seconds to first launch. -> Mitigation: idempotent; runs once; show in the dashboard status.

## Migration Plan

1. `scripts/build-postgres.js` (new) + add to `predist`; add `platformBundles.postgresVersion`.
2. `scripts/build-python-litellm.js`: add prisma install + generate + engine-copy.
3. `supervisor/descriptors.js`: postgres descriptor + LiteLLM `dependsOn` + env (DATABASE_URL, LITELLM_MASTER_KEY, LITELLM_SALT_KEY, STORE_MODEL_IN_DB, PRISMA_QUERY_ENGINE_BINARY, PATH).
4. `bootstrap/first-run.js`: `LITELLM_SALT_KEY` generation + `hasBundledPostgres` detection.
5. `local-services.js` + `electron/config/settings.js`: `SETTING_KEYS` additions.
6. `server.js`: `/ui/*` proxy + SPA fallback exclusion; `/api/config` keeps `apiBaseUrl`.
7. `web/src/pages/EmbeddedServicePages.tsx`: `LiteLLMPage` iframe.
8. `electron-builder.yml`: `extraResources` postgres entry; mac codesign hook (D6).
9. Local dev verify: `npm run predist` builds postgres + prisma; `npm start` spawns postgres -> LiteLLM (DB init) -> dashboard loads at `/litellm` (no setup error); sign in with master key.
10. CI: push tag -> 3 installers build with bundled postgres + prisma.

**Rollback**: revert the build scripts + descriptor + env + `LiteLLMPage` + `/ui/*` proxy. The postgres data dir + prisma engine are regenerable (delete + rebuild). No data migration (fresh DB).

## Open Questions

- Should `LITELLM_MASTER_KEY` be a distinct value from `LITELLM_API_KEY`, or the same? (Lean: same - one less secret; the proxy master_key and the UI master key are the same concept.)
- Run `initdb` in the supervisor start path or in `bootstrap/first-run.js`? (Lean: supervisor start path - keeps child lifecycle ownership; but bootstrap is where other first-run seeding lives. Decide during implementation.)
- Should the `LiteLLMPage` keep the copyable API base URL (for direct API use) alongside the iframe, or drop it now that the dashboard is embedded? (Lean: keep `apiBaseUrl` in `/api/config` but drop the copyable field from the page - the dashboard is the primary surface.)
