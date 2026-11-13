## Why

Today `npm run dist` only builds a `.app`/`.exe` **locally** on a developer machine - and only that machine, because `resources/node/` (the bundled standalone Node the supervisor spawns child servers with) is hand-placed once and never rebuilt. It is gitignored, has no build script, and is not checked by `verify-bundle.js`. A fresh checkout (CI or a new contributor) runs `predist` which rebuilds OpenConnector + Python + LiteLLM but silently leaves Node absent, so `electron-builder` ships an app that launches a window but can never start its backend.

We want GitHub Actions to produce the distributable installers - `.dmg` (mac arm64 + x64) and `.exe` (win x64) - on a tag push, attach them to a GitHub Release, and do it reproducibly from a clean checkout. Code signing + notarization are gated on secrets being present so unsigned CI smoke builds work today, and signed release builds work once certificates are added.

## What Changes

- **Close the bundled-Node gap.** Add `scripts/build-node.js` that downloads the standalone Node binary for the host platform (mirroring `scripts/build-python-litellm.js`'s python-build-standalone fetch), wire it into `npm run predist`, and add a Node check to `scripts/verify-bundle.js`. No more hand-placed `resources/node/`.
- **Pin the Node version** so the standalone Node ABI matches the prebuilt native-addon `.node` files chosen at `npm ci` time (`better-sqlite3`, `tree-sitter`, `fsevents`) - the app uses `npmRebuild: false`, so the prebuilt must match. Express this via `engines.node` + the standalone download version.
- **Add `.github/workflows/release.yml`** - a two-job matrix (`macos-latest` arm64, `windows-latest` x64) that runs `npm ci` -> `npm run predist` -> `npm run dist`, with `pip`/`resources`/`node_modules` caching, then uploads the `.dmg` / `.exe` as build artifacts.
- **Tag-triggered release.** On a `v*` tag, attach all installers (mac arm64 + x64 + win) to a GitHub Release (via `softprops/action-gh-release`). Also expose a `workflow_dispatch` for on-demand builds that don't cut a release.
- **Signing gated on secrets.** macOS: `CSC_LINK`/`CSC_KEY_PASSWORD` + notarization (`APPLE_ID`/`APP-SPECIFIC-PASSWORD`/`TEAM_ID`) + an `afterSign` hook. Windows: `WIN_CSC_LINK`. When absent, the build still succeeds with a warning (unsigned) - so CI works pre-cert and the `desktop-supervisor` task 4.8 (signing + notarization) is satisfied by the secret-gated path rather than blocking everything.
- **Out of scope**: Linux packaging, macOS universal (single dmg for both arches - we ship separate arm64 + x64 dmgs instead), iOS/Android, hosted/multi-tenant backend.

## Capabilities

### New Capabilities
- `release-pipeline`: reproducibly builds, signs, and publishes the Platform desktop installers from a clean checkout via GitHub Actions, on demand and on tag, with graceful unsigned fallback.

### Modified Capabilities
- _(none - the desktop app itself is unchanged; this is how it gets built and distributed.)_

## Impact

- **New files**: `.github/workflows/release.yml`; `scripts/build-node.js`.
- **Modified**: `scripts/verify-bundle.js` (add bundled-Node check); `package.json` (`predist` runs `build-node.js`, add `engines.node`); `electron-builder.yml` (optional `afterSign` notarization hook + `win.certificateSubjectName` wiring, no target changes).
- **Secrets** (GitHub Actions, all optional - unset = unsigned build): `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APP-SPECIFIC-PASSWORD` (or `AC_PASSWORD`), `TEAM_ID`, `WIN_CSC_LINK`.
- **Cost**: private-repo Actions metering - macOS runners 10x, Windows 2x. Mitigated by caching; full packaging only runs on tag / dispatch, not every push.
- **Dev workflow**: `npm start` and local `npm run dist` unchanged; the only behavioral change is that a fresh-checkout `npm run predist` now also produces `resources/node/`.
