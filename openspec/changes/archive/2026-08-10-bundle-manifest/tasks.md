# Tasks

## 1. Manifest module + default manifest

- [x] 1.1 Create `platform.bundle.json` at repo root with all components selected (`postgres: "auto"`), current zero-config MCP seeds, current `skills/` names, and empty permissions — the byte-equivalent-to-today default
- [x] 1.2 Create `bundle-manifest.js` exporting `resolveBundle({ env, projectRoot })`: load + validate the JSON (unknown keys/components → build-time error, runtime fallback to defaults), apply `PLATFORM_BUNDLE_COMPONENTS` override (`all` / `none` / comma list), resolve `postgres: "auto"` → follows litellm; return `{ components, mcpServers, skills, permissions }`
- [x] 1.3 Unit-check `resolveBundle` via `node --test` (or a plain assertion script): default/missing/invalid manifest, env override, postgres auto-resolution

## 2. Conditional bundle build

- [x] 2.1 `scripts/postinstall-bundle.js`: read `resolveBundle()`; skip `build-openconnector.js` / `build-python-litellm.js` / `build-postgres.js` for deselected components (always run `build-node.js`); log skipped components
- [x] 2.2 `scripts/verify-bundle.js`: assert presence of exactly the selected component set (+ node always); fail on missing selected resources; warn (dev) or fail (CI, via `CI` env) when a deselected component dir exists in `resources/`
- [x] 2.3 Smoke test: `PLATFORM_BUNDLE_COMPONENTS=openconnector npm run predist` builds only node + openconnector; default `npm run predist` builds everything (idempotent cache preserved)

## 3. JS electron-builder config

- [x] 3.1 Create `electron-builder.js`: mechanical port of `electron-builder.yml`, with `extraResources` entries for `openconnector/`, `python/`+`litellm/`, and `postgres/` pushed conditionally from `resolveBundle()`; add `platform.bundle.json` to `files:`
- [x] 3.2 Verify parity: run electron-builder's effective-config for the all-components manifest and diff against the old yml semantics (resources, filters, mac/win targets, afterPack)
- [x] 3.3 Delete `electron-builder.yml`; confirm `sign-postgres.cjs` no-ops cleanly when `resources/postgres` is absent (guard if needed)
- [x] 3.4 Smoke test: `PLATFORM_BUNDLE_COMPONENTS=none npm run dist` produces an installer without python/litellm/postgres/openconnector payloads; default `npm run dist` matches today's contents

## 4. Extensions DB schema: origin / locked / permissions

- [x] 4.1 Add idempotent migration in the DB layer (`PRAGMA table_info` guard + `ALTER TABLE`): `origin TEXT NOT NULL DEFAULT 'user'`, `locked INTEGER NOT NULL DEFAULT 0`, `permissions TEXT` (nullable JSON) on `extension_configs`
- [x] 4.2 `extension-store.js`: thread origin/locked/permissions through `seedExtensionConfig`, `addExtensionConfig`, list/get serializers; `seedMcpServer` accepts `{ origin, locked, permissions }`
- [x] 4.3 Verify migration on an existing dev DB: rows report `origin: "user"`, `locked: false`, null permissions; all extensions API tests still pass

## 5. First-run seeding of bundled extensions

- [x] 5.1 `server.js` `initAgent()` (moved from `bootstrap/first-run.js` — better-sqlite3 cannot load in the Electron main process ABI; see design D5): connect enabled manifest `mcpServers` before session creation + seed each entry (`origin: "bundled"`, manifest `enabled`, `locked`/`permissions` from the `permissions` map) via `extensionStore.seedMcpServer` — INSERT OR IGNORE, best-effort when DB unavailable
- [x] 5.2 Surface manifest `skills` entries as bundled at the API layer (`origin` + `locked`/`permissions` derived from the manifest in `GET /api/extensions/skills`; file skills are not DB rows); ship `platform.bundle.json` in the packaged app (`files:`) so packaged startup reads the same manifest
- [x] 5.3 `server.js`: when openconnector is a selected component, seed the OC `/mcp` record with `origin: "bundled"`; leave the 30s-retry connect and mcp.json seeding behavior unchanged
- [x] 5.4 Verify: fresh `PLATFORM_DATA_DIR` run lists bundled entries in `/api/extensions/mcp` + `/api/extensions/skills`; a second run preserves user edits (INSERT OR IGNORE)

## 6. Locked-entry API guards

- [x] 6.1 `server.js` MCP endpoints: DELETE / PATCH(enabled/config) / PUT on a locked record → 400 with explanatory error; locked state included in list responses
- [x] 6.2 `server.js` skills endpoints: same guards for locked bundled skills (alongside the existing built-in-skill 400 guard) — lock state derived from the manifest (file skills are not DB rows); the manifest lock also wins over a DB row sharing the name
- [x] 6.3 Extend the extensions API tests: locked delete/disable returns 400; non-locked bundled entries remain fully manageable (`scripts/test-bundle-locking.js` — spawns server.js with a throwaway manifest via the new `PLATFORM_BUNDLE_MANIFEST` path override)

## 7. Supervisor + launcher manifest gating

- [x] 7.1 `supervisor/descriptors.js`: `hasBundledLiteLLM/OpenConnector/Postgres` additionally require manifest selection (not selected ⇒ treated as absent ⇒ existing http-external fallback path); external URLs unaffected
- [x] 7.2 `local-services.js`: startup summary distinguishes "excluded by manifest" from "resources absent"; missing-resources warning only mentions selected-but-unbuilt components
- [x] 7.3 Verify: with `PLATFORM_BUNDLE_COMPONENTS=openconnector npm start`, litellm/postgres report excluded, OC spawns, server.js healthy; with an external `LITELLM_BASE_URL` + deselected litellm, the external URL is used as-is

## 8. CI workflow

- [x] 8.1 `.github/workflows/release.yml`: add `workflow_dispatch` `components` input (default empty → manifest unchanged); export `PLATFORM_BUNDLE_COMPONENTS` for predist + dist steps on all matrix jobs
- [x] 8.2 Add `hashFiles('platform.bundle.json')` + the resolved `PLATFORM_BUNDLE_COMPONENTS` value to the resources cache key
- [x] 8.3 Make artifact names distinguish the component set for dispatch builds (e.g. suffix `-lean` when selection ≠ all)
- [x] 8.4 Trigger a `workflow_dispatch` run with `components=openconnector` and verify the artifacts exclude python/litellm/postgres and the app launches

## 9. Docs + cleanup

- [x] 9.1 Update `CLAUDE.md` (Local services / CI release sections) for the manifest, JS builder config, and dispatch input
- [x] 9.2 Add `platform.bundle.json` comments-equivalent documentation (a `platform.bundle.example.json` or README section) covering every key and the `PLATFORM_BUNDLE_COMPONENTS` override
