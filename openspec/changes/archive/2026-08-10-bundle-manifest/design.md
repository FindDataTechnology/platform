## Context

Today every installer unconditionally bundles LiteLLM (Python + venv, hundreds of MB), OpenConnector, and Postgres via static `extraResources` in `electron-builder.yml`, and the supervisor declares their descriptors unconditionally (`supervisor/descriptors.js`), gated at runtime only by env vars (`*_BASE_URL`) and resource presence. `server.js` wires both through special-case code (dedicated proxy modules, SPA-fallback exclusions, a hardcoded OC `/mcp` registration with 30s retry). Separately, the extensions system (`extension-store.js` + SQLite + marketplace) already models user-installed MCP servers and skills with enable/disable. There is no bridge between the two worlds: a packager cannot say "ship without LiteLLM" or "pre-install these MCP servers with this permission policy" without editing code.

## Goals / Non-Goals

**Goals:**
- One manifest (`platform.bundle.json`) is the single source of truth for: which heavyweight components get built and bundled, which MCP servers/skills are pre-installed, and their permission/lock metadata.
- Deselecting a component removes it from the installer (build + packaging) with zero code edits; the runtime treats its absence as the existing "resources not found" graceful-degradation path.
- CI (`release.yml`) exposes component selection as a `workflow_dispatch` input.
- Bundled MCP servers/skills land in the extensions DB with `origin: "bundled"` and `locked`, flowing through the same seed → enable → connect path as user extensions; locked entries cannot be deleted or disabled through the API.
- Default manifest (all components selected, current bundled MCP/skills) produces a bundle equivalent to today's.

**Non-Goals:**
- Tool-level permission *enforcement* and the `refreshSessionTools` gap fix — follow-up change `extension-tool-permissions` (this change only stores the `permissions` column).
- Management-UI drawer / route consolidation for `/litellm` and `/openconnector` — follow-up change `extension-drawer-ui`.
- Runtime download/install of components into a shipped package — follow-up change `runtime-component-install`.
- Changing LiteLLM's role as an env-configured model provider (pi-provider-litellm registration stays env-driven).
- New extension types (e.g. customer-service modules). The manifest schema reserves a `type` axis but only `mcp` and `skill` are implemented.

## Decisions

### D1: `platform.bundle.json` at repo root, loaded by one module (`bundle-manifest.js`)
Format:

```json
{
  "components": {
    "litellm":       { "include": true },
    "openconnector": { "include": true },
    "postgres":      { "include": "auto" }
  },
  "mcpServers": {
    "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"], "enabled": true }
  },
  "skills": ["computer-shell", "computer-file-system", "computer-process"],
  "permissions": {
    "mcp:fetch": { "allow": ["*"], "deny": [] },
    "skill:computer-shell": { "locked": true }
  }
}
```

- `components.<name>.include`: `true | false | "auto"`. `"auto"` is only meaningful for `postgres` and resolves to "included iff litellm is included and no external `DATABASE_URL` is configured at build time is unknowable → resolve at *runtime*": postgres is *bundled* when litellm is bundled; the supervisor's existing external-`DATABASE_URL` override still wins at runtime.
- `PLATFORM_BUNDLE_COMPONENTS` env (comma list, or `none`/`all`) overrides `components.*` — this is how CI selects without editing the file.
- One `resolveBundle({ env, projectRoot })` function returns `{ components: {litellm, openconnector, postgres}, mcpServers, skills, permissions }` fully resolved. All consumers (build scripts, builder config, first-run, supervisor) call it — no consumer parses the JSON itself.

**Alternatives considered:** per-component flags scattered across env vars (rejected: no single reviewable artifact; the manifest is also the permission-policy home). JSON with comments / YAML (rejected: repo convention is plain JSON for gitignored config and JSON5 isn't a dependency; comments live in the spec + example file).

### D2: `electron-builder.yml` → `electron-builder.config.mjs`
electron-builder discovers `.mjs` config natively. The JS config imports `resolveBundle()` and builds the `extraResources` array conditionally: `resources/openconnector/`, `resources/python/` + `resources/litellm/`, `resources/postgres/` entries are pushed only when the corresponding component is selected. `resources/node/` and `files:` are unchanged. The static yml is deleted; `sign-postgres.cjs` (afterPack) already no-ops when postgres is absent (it just finds no binaries to sign — verify this in implementation).

**Alternatives considered:** keep yml + a `beforePack` hook that deletes unselected resources (rejected: wasteful — they'd still be built and packed into the working dir first; filtering at config time is exact). Multiple static yml variants + `-c` flag (rejected: combinatorial, drifts).

### D3: Build scripts skip deselected components; `verify-bundle.js` asserts the manifest
`scripts/postinstall-bundle.js` (predist) reads `resolveBundle()` and skips `build-openconnector.js` / `build-python-litellm.js` / `build-postgres.js` for deselected components. `verify-bundle.js` inverts from "assert all four present" to "assert exactly the selected set present, and selected-set consistency (litellm ⇒ python)". `build-node.js` always runs (server.js always needs the bundled Node).

CI cache key: add `hashFiles('platform.bundle.json')` to the resources cache key — a manifest change must not restore a stale all-components cache (this extends the existing "cache key must hash build inputs" convention).

### D4: Runtime gating reuses resource-presence, plus a manifest check in the supervisor
`supervisor/descriptors.js`'s `hasBundledLiteLLM/OpenConnector/Postgres()` gain a manifest-selection check: not selected ⇒ treated as absent ⇒ the descriptor falls through to the existing `http-external` branch (enabled only when an external URL is set). **External URLs keep working regardless of the manifest** — the manifest governs *bundling*, not whether a user may point at a remote instance. This means unselected-component behavior is 100% the already-shipped, already-tested degradation path; no new runtime states.

In a packaged app the manifest ships inside the app dir (`files:` includes `platform.bundle.json`); in dev it's read from the repo root. `PLATFORM_DATA_DIR` stores nothing manifest-related.

### D5: Startup seeds bundled extensions into the DB with origin/locked
`server.js` `initAgent()` (the only place better-sqlite3 can load — see below) seeds each manifest `mcpServers` entry via `extension-store.js` `INSERT OR IGNORE` (`origin: "bundled"`, the manifest `enabled` state, plus `locked`/`permissions` from the `permissions` map, key `"mcp:<name>"`), right after the existing mcp.json seeding. Enabled manifest servers are also *connected* at startup (merged into the `connectServers` input before session creation so their tools join the session allowlist); mcp.json wins name collisions (operator config overrides the packaged default). `INSERT OR IGNORE` preserves user edits across upgrades; changing a bundled entry's config in a new package version is out of scope (packagers ship new entries under new names).

**Placement revision (implementation-found):** the original D5 put seeding in `bootstrap/first-run.js` because it "owns one-time persistence and runs before the DB is opened". That is architecturally impossible: first-run executes inside the Electron main process, and better-sqlite3's prebuilt binding is compiled for the *bundled standalone Node's* ABI (`npmRebuild: false`) — it cannot load in Electron's Node. server.js is the only process that both runs under a compatible Node and opens the DB, so seeding lives next to the existing mcp.json/OC seed blocks. Both entry points (`npm start` and the Electron supervisor) spawn server.js, so coverage is unchanged.

Manifest `skills` entries are *not* DB rows: file skills ship under `skills/` regardless, so the API layer (`GET /api/extensions/skills`) derives `origin: "bundled"` + `locked`/`permissions` (key `"skill:<name>"`) from the resolved manifest for listed names; non-manifest file skills report `origin: "file"`; custom (DB) skills report `origin: "user"`.

DB migration: `extension_configs` gains `origin TEXT NOT NULL DEFAULT 'user'`, `locked INTEGER NOT NULL DEFAULT 0`, `permissions TEXT` (JSON, nullable) via idempotent `ALTER TABLE` guarded by `PRAGMA table_info` (the project has no migration framework; follow the existing pattern).

`server.js` startup: the hardcoded OC `/mcp` registration (20×1.5s retry) and the mcp.json seeding stay, but the OC MCP record is seeded with `origin: "bundled"` when openconnector is a selected component, so the Installed tab shows provenance. Delete/disable API endpoints reject `locked` records with 400 (mirroring the existing built-in-skill 400 guard).

**Alternatives considered:** seeding in `bootstrap/first-run.js` (rejected: better-sqlite3 cannot load in the Electron main process — ABI mismatch with the bundled Node; see above). A separate `bundled-extensions.json` store (rejected: two registries for one concept; the whole point is unification).

### D6: Locked semantics — immutable, but visible
`locked: true` (from `permissions.<key>.locked`) means: API DELETE → 400, API disable → 400, config edit → 400. The entry remains visible everywhere with a "bundled" badge. Rationale: locked exists so a packager can guarantee a capability survives end-user tinkering; allowing disable would defeat it. Non-locked bundled entries (default) behave like user entries except they show origin and survive in the catalog.

## Risks / Trade-offs

- [Cache poisoning: CI restores an all-components `resources/` over a slim manifest] → cache key hashes `platform.bundle.json` + `PLATFORM_BUNDLE_COMPONENTS`; `verify-bundle.js` also asserts *absence* of deselected component dirs before packing.
- [JS builder config silently diverges from the old yml] → implementation starts as a mechanical port; a task diffs the effective `electron-builder` config (`--config` dry run / `electron-builder effective-config`) against the yml baseline for the all-components manifest.
- [Packager excludes litellm but leaves `LITELLM_BASE_URL` in a shipped settings.json] → external URL still works by design (D4); document in the spec so it's a feature, not a surprise.
- [first-run runs before DB ready / DB unavailable] → seeding step is best-effort with a warning, matching the repo's graceful-degradation convention; the extensions API already returns 503 when the DB is down.
- [Scope creep into permissions enforcement / drawer UI] → both explicitly non-goals; the `permissions` column is written now and read later.

## Migration Plan

No user-data migration beyond the three additive DB columns (default values make every existing row a non-locked `user` extension — current behavior preserved). Dev flows (`npm start`, `npm run dist` with default manifest) are byte-comparable to today. Rollback = restore `electron-builder.yml` and delete `platform.bundle.json`; the runtime treats a missing manifest as "all components selected, no bundled extensions, no locks" (resolveBundle defaults), so old packages remain valid.

## Open Questions

- Should `verify-bundle.js` also *fail* when a deselected component dir exists in `resources/` (stale local build), or just warn and let the builder config exclude it? (Leaning: warn in dev, fail in CI.)
- Manifest `skills` entries: ship-all-of-`skills/` + manifest controls seeding only (chosen in D5), vs manifest also filtering the `files:` copy. Revisit if skill payloads grow.
