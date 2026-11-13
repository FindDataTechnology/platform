## 1. Bundle Postgres binaries

- [x] 1.1 Add `postgresVersion: "17.10.0-beta.17"` to `package.json` `platformBundles`.
- [x] 1.2 Write `scripts/build-postgres.js` (mirror `scripts/build-node.js`): detect platform (mac arm64/x64 -> `@embedded-postgres/darwin-arm64`; win x64 -> `@embedded-postgres/windows-x64`); fetch the tarball SHA512 from `https://registry.npmjs.org/@embedded-postgres/<pkg>/<version>`; curl the tarball from `registry.npmjs.org`; verify SHA512 (`crypto.timingSafeEqual` vs `dist.integrity`); extract `package/native/{bin,lib,share}` -> `resources/postgres/` (flatten the `package/` prefix); `chmod +x` mac `postgres`/`initdb`/`pg_ctl`; skip-if-built (`resources/postgres/bin/postgres` exists); size sanity check.
- [x] 1.3 Add `node scripts/build-postgres.js` to `package.json` `scripts.predist` (before `verify-bundle`).
- [x] 1.4 Add an `extraResources` entry to `electron-builder.yml`: `from: resources/postgres/` -> `to: postgres/` (filter out `*.tar.gz`).
- [x] 1.5 Add `resources/postgres/bin/postgres` presence to `scripts/verify-bundle.js`.

## 2. Prisma in the bundled LiteLLM venv

- [x] 2.1 In `scripts/build-python-litellm.js`, after `pip install litellm[proxy]`: `pip install prisma==0.11.0`.
- [x] 2.2 Set `PRISMA_BINARY_CACHE_DIR=<venv>/prisma-cache` + `PRISMA_USE_GLOBAL_NODE=true`, then run `<venv>/bin/prisma generate --schema=<venv>/lib/python3.13/site-packages/litellm/proxy/schema.prisma` (Windows: `Scripts/prisma.exe`).
- [x] 2.3 `find <cache> -name "query-engine-*"` -> copy to `<venv>/prisma-engine/query-engine` (stable path; the generated client bakes build-time paths).
- [x] 2.4 Add `<venv>/prisma-engine/query-engine` presence to `scripts/verify-bundle.js`.
- [x] 2.5 Run `npm run predist` locally; confirm `resources/postgres/` + `resources/litellm/venv/prisma-engine/query-engine` + `site-packages/prisma/models.py` exist.

## 3. Supervisor: postgres descriptor + LiteLLM depends-on + env

- [x] 3.1 Add a `postgresBinPath(resourcesDir)` helper to `supervisor/descriptors.js` (mac: `resources/postgres/bin/postgres`; win: `resources/postgres/bin/postgres.exe`).
- [x] 3.2 Add a `postgres` descriptor: `kind: "postgres"`; resolve bundled-vs-external (bundled when `resources/postgres/bin/postgres` exists AND no external `DATABASE_URL`); first-run `initdb -D <storeDir("postgres-data")> --auth=trust -U postgres`; start `pg_ctl -D <dataDir> -o "-p <freePort> -c listen_addresses=localhost" -w start` (win: `pg_ctl.exe`); after start, `createdb -p <port> -U postgres litellm` (idempotent); health = TCP-poll `127.0.0.1:<port>`; stop `pg_ctl -D <dataDir> -m fast -w stop`.
- [x] 3.3 Set the LiteLLM descriptor `dependsOn: ["postgres"]`; after postgres is healthy, inject `DATABASE_URL=postgresql://postgres@localhost:<pgPort>/litellm` into the LiteLLM child env.
- [x] 3.4 Add to the LiteLLM descriptor `env`: `LITELLM_MASTER_KEY` (=`LITELLM_API_KEY`), `LITELLM_SALT_KEY` (from settings), `STORE_MODEL_IN_DB=True`, `PRISMA_QUERY_ENGINE_BINARY=<resourceRoot>/litellm/venv/prisma-engine/query-engine`, and `PATH=<resourceRoot>/litellm/venv/bin:<resourceRoot>/node/bin:$PATH` (win: `Scripts` + `node` + `%PATH%`).
- [x] 3.5 In `supervisor/process.js` confirm child env merge (`{ ...process.env, ...descEnv }`) preserves the prepended PATH (it does at line ~23).
- [x] 3.6 In `bootstrap/first-run.js`: add `hasBundledPostgres` detection; generate `LITELLM_SALT_KEY = crypto.randomBytes(32).toString("hex")` once (persist to settings, never overwrite) when bundled LiteLLM + postgres exist.

## 4. Env wiring (SETTING_KEYS)

- [x] 4.1 Add `DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` to `SETTING_KEYS` in `local-services.js` (so .env values forward to the supervisor).
- [x] 4.2 Add the same three to `SETTING_KEYS` in `electron/config/settings.js` (packaged-app parity).

## 5. Embed the LiteLLM dashboard in-page

- [x] 5.1 In `server.js`: proxy `/ui/*` -> LiteLLM `/ui/*` (token-injected `LITELLM_API_KEY`, via the existing `litellmWebProxy` when litellmEnabled); add `ui\/` to the SPA-fallback exclusion regex (`^\/(?!api\/|oc-web|litellm-web|assets\/|v1\/|ui\/).*`).
- [x] 5.2 In `web/src/pages/EmbeddedServicePages.tsx`: change `LiteLLMPage` to render `<EmbeddedFrame src="/litellm-web/ui" />` (same as `OpenConnectorPage`) when configured; drop the open-in-new-tab link + the copyable master-key/api-base-URL fields (keep `apiBaseUrl` in `/api/config` for direct API use). Show the disabled placeholder when not configured / DB not ready.
- [x] 5.3 `npm run web:build`.
- [x] 5.4 Verify: `/litellm` renders the LiteLLM dashboard iframe (no "Missing Environment Variables" screen); sign in with the master key; the dashboard loads models/keys.

## 6. macOS codesigning

- [x] 6.1 Add an `electron-builder` `afterPack` hook (or a `scripts/sign-postgres.js`) that `codesign --options runtime --sign <identity>` `resources/postgres/bin/{postgres,initdb,pg_ctl}` + `resources/postgres/lib/postgresql/*.dylib` on mac, gated on signing secrets (skip gracefully when absent).

## 7. Build, verify, sync

- [x] 7.1 `npm run predist` locally on mac - confirm `resources/postgres/` (universal) + the venv prisma engine are built.
- [x] 7.2 `npm start` - confirm the supervisor starts postgres -> LiteLLM (DB init) -> `server.js`; `/litellm` shows the embedded dashboard (no setup error); a chat completion to `Agent-harness` still routes.
- [ ] 7.3 `npm run dist -- --arm64` locally - confirm the DMG includes `Resources/postgres/` + `Resources/litellm/venv/prisma-engine/`.
- [x] 7.4 `openspec validate bundle-postgres-embed-litellm --strict`; fix any flagged deltas.
- [ ] 7.5 Push a `v*` tag (or `workflow_dispatch`) - confirm the 3 CI matrix builds (mac arm64, mac x64, win x64) each produce an installer with bundled postgres + prisma.
- [ ] 7.6 After implementation, `/opsx:sync` the delta specs into `openspec/specs/{postgres-bundle,desktop-supervisor,litellm-web,litellm-provider}/` and `/opsx:archive` the change.
