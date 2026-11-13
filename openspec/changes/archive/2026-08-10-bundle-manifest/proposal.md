## Why

LiteLLM, OpenConnector, and Postgres are unconditionally built into every installer (`extraResources` in `electron-builder.yml`, hardcoded descriptors in `supervisor/descriptors.js`) and wired into `server.js` through special-case env vars, proxy routes, and SPA-fallback exclusions. There is no way to ship a lean package without them (the Python venv alone is hundreds of MB), and no uniform way to pre-install MCP servers / skills at packaging time with permission policy. Meanwhile the extensions system (DB + marketplace + Installed tab) already models installable MCP servers and skills — bundled components should be entries in that same model, not parallel special cases.

## What Changes

- **Add `platform.bundle.json`** — a single build-time manifest declaring: which heavyweight components to bundle (`litellm`, `openconnector`, `postgres`), which MCP servers and skills to pre-install, and per-extension permission policy (tool allow/deny globs, `locked` flag).
- **Conditionalize the bundle build** — `scripts/build-*.js` (via `predist`) build only the components selected in the manifest (skipping LiteLLM saves the Python + venv payload); `PLATFORM_BUNDLE_COMPONENTS` env overrides the manifest for CI.
- **Replace static `electron-builder.yml` with a JS config** (`electron-builder.config.mjs`) that reads the manifest and generates `extraResources`/`files` dynamically, so deselected components are excluded from the installer.
- **GitHub Actions `workflow_dispatch` inputs** for component selection, passed through as `PLATFORM_BUNDLE_COMPONENTS`; the resources cache key additionally hashes `platform.bundle.json`.
- **First-run seeding into the extensions DB** — bundled MCP servers and skills are seeded with `origin: "bundled"` plus their `locked`/permission metadata, going through the same enable/connect path as user-installed extensions instead of special-case wiring.
- **Supervisor descriptors become manifest-driven** — LiteLLM/OpenConnector/Postgres descriptors are generated only for components present in the manifest (and still gated on bundled resources + external-URL override); absent components resolve to `enabled: false`, exercising the existing graceful-degradation path.
- **server.js de-coupling (scoped)** — the OpenConnector MCP registration stays but reads from the seeded extension record rather than hardcoded env; LiteLLM provider registration keeps its env-driven behavior (unchanged this change). Management UI unification (drawer) and tool-permission enforcement are follow-up changes, out of scope here.

## Capabilities

### New Capabilities
- `bundle-manifest`: the manifest file format, component selection semantics (build-time + CI override), and first-run seeding of bundled extensions into the extensions DB.

### Modified Capabilities
- `desktop-supervisor`: descriptors for litellm/openconnector/postgres are generated from the manifest + bundled-resource presence instead of being unconditionally declared.
- `release-pipeline`: the build consumes the manifest (conditional predist, JS builder config) and gains a `workflow_dispatch` component-selection input; cache key hashes the manifest.
- `local-services-launcher`: `npm start` spawns only manifest-selected local services; unselected services are reported as excluded rather than probed.
- `extension-runtime-management`: extension records gain `origin` (`bundled`|`user`) and `locked` attributes; locked bundled extensions cannot be deleted or disabled via the API.

## Impact

- **New files**: `platform.bundle.json`, `electron-builder.config.mjs` (replaces `electron-builder.yml`), `bundle-manifest.js` (manifest load/validate/resolve), specs under `openspec/specs/bundle-manifest/`.
- **Modified**: `scripts/postinstall-bundle.js`, `scripts/verify-bundle.js`, `supervisor/descriptors.js`, `local-services.js`, `bootstrap/first-run.js`, `electron/config/settings.js` (keys passthrough as needed), `server.js` (OC MCP registration reads seeded record; extension delete/disable guards for locked entries), `extension-store.js` / DB layer (`origin`, `locked`, `permissions` columns), `.github/workflows/release.yml` (dispatch input + cache key), `package.json` (`dist` script uses the JS config).
- **Behavior**: default manifest selects all current components → byte-equivalent bundle to today; deselecting produces a leaner installer whose server starts with graceful degradation (no code path crashes on missing components).
- **Out of scope (follow-up changes)**: tool-level permission enforcement + `refreshSessionTools`, extension management-UI drawer + route consolidation, runtime download/install of components after shipping.
