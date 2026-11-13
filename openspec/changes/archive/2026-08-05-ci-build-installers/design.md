## Context

The Platform desktop app is packaged with `electron-builder` (`electron-builder.yml`): `mac` target `dmg` (arm64 + x64), `win` target `nsis` x64. `asar: false` because a **bundled standalone Node** (`resources/node/`) runs `server.js` + the LiteLLM/OpenConnector sidecars - it cannot read inside an asar archive. `npmRebuild: false` because native addons (`better-sqlite3`, `tree-sitter`, `fsevents`) run on the **bundled Node's standard ABI** using the prebuilt `.node` files already in `node_modules` - no `electron-rebuild`.

The build flow is:

```
npm run predist  ─┬─ scripts/build-openconnector.js   (clone pinned OC SHA -> registry.generated.ts)
                  ├─ scripts/build-python-litellm.js  (python-build-standalone + venv + litellm[proxy])
                  └─ scripts/verify-bundle.js         (assert OC/Python/LiteLLM present)
npm run dist     ─┬─ npm --prefix web run build        (Vite -> web/dist)
                  └─ electron-builder                  (reads electron-builder.yml -> dist/*.dmg|*.exe)
```

**`build-python-litellm.js` is host-aware**: it picks a platform-specific `python-build-standalone` asset (`aarch64-apple-darwin` vs `x86_64-pc-windows-msvc`) and only runs on `darwin/arm64` or `win32/x64`. A `pip install` produces native wheels for the **host interpreter only** - a Windows venv (`venv/Scripts/litellm.exe`) cannot exist on a macOS host. **This forces a platform matrix.** `electron-builder`'s mac target also requires macOS; its win target is most reliable on Windows. (The existing design already states: *"build the `.exe` on a Windows host."*)

**The gap**: `resources/node/`, `resources/python/`, `resources/litellm/`, `resources/openconnector/` are all gitignored. `predist` rebuilds three of the four. The fourth - the bundled Node - has **no build script** and is **not checked by `verify-bundle.js`**, yet `electron-builder.yml` copies it as `extraResources`. Locally it works because a Node binary was hand-placed once; CI has no such luxury.

**Signing state** (`desktop-supervisor` task 4.8 - open): `electron-builder.yml` has signing comments but no `afterSign` notarization hook. Unsigned: the `.dmg` is quarantined by Gatekeeper on other Macs; the `.exe` hits SmartScreen. Acceptable for internal/CI; not for distribution.

Repo is private (`scs001/law-private`), already on GitHub, no `.github/workflows/` yet.

## Goals / Non-Goals

**Goals:**
- A clean-checkout CI build that produces a working `.dmg` (mac arm64 + x64) and `.exe` (win x64) - reproducible, no hand-placed binaries.
- Tag push (`v*`) cuts a GitHub Release with all installers (arm64 + x64 + win) attached; `workflow_dispatch` for on-demand builds.
- Code signing + notarization work **when secrets are present** and degrade gracefully (unsigned build still succeeds) when they are not.
- Close the `resources/node/` build gap so local `predist` is also self-sufficient.

**Non-Goals:**
- Linux packaging, macOS universal (single dmg for both arches; we ship separate arm64 + x64 dmgs instead), iOS/Android, hosted backend.
- Auto-updates / a release feed (separate change; `electron-updater` later).
- Cross-compiling both OSes from one runner (ruled out - see D1).

## Decisions

**D1 - Two-runner matrix, not cross-compile.** macOS arm64 runner builds the `.dmg`; Windows x64 runner builds the `.exe`. *Why not Wine-on-mac:* the Python venv is host-interpreter-specific; a Windows venv cannot be produced on macOS. electron-builder cross-build is also fragile for NSIS. *Trade-off:* two jobs, longer wall-clock, macOS 10x / Windows 2x private-repo billing - mitigated by caching and tag-only full packaging.

**D2 - Tag push + manual dispatch, not push-to-branch.** Full packaging is expensive; run it on `v*` tags (release) and `workflow_dispatch` (on-demand). A cheap `predist`-only check can run on PRs later, but is not in scope here. *Why:* cost control on a private repo.

**D3 - Close the Node gap with `scripts/build-node.js`, mirroring `build-python-litellm.js`.** Download the standalone Node for the host platform into `resources/node/` (mac arm64 / win x64), idempotent + cached. Wire into `predist`; check in `verify-bundle.js`. *Why over committing the binary:* large, platform-specific, would bloat the repo and collide across OSes. *Why over `ELECTRON_RUN_AS_NODE`:* already rejected by the supervisor design (D4) - it ties child ABI to Electron's Node and requires `electron-rebuild`.

**D4 - Bundled Node ABI == install-time Node ABI, via `process.version` auto-match (not pinning).** `npmRebuild: false` means `better-sqlite3`/`tree-sitter`/`fsevents` use the `.node` compiled at `npm ci` time against the runner's Node. The bundled standalone Node must have the **same ABI** or the app launches and crashes on first native call. `scripts/build-node.js` downloads the standalone Node **matching `process.version`** (the exact Node running the build), with a `PLATFORM_NODE_VERSION` override for explicit pinning. This makes the invariant hold *automatically* in every environment - local dev and CI - regardless of which Node is active, with no version coordination to get wrong. A loose `engines.node: ">=22"` documents a contributor floor. (Locally `better-sqlite3` is source-compiled; CI runners have build toolchains, so source compilation works there too - prebuild coverage is not required.)

**D5 - Signing + notarization gated on secrets (built-in, no custom hook).** Use electron-builder's built-in `mac.notarize: true` + `hardenedRuntime: true` rather than a custom `afterSign` hook. electron-builder's `notarizeIfProvided` builds credentials from env (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) and **skips with a warning when they're absent** - so unsigned CI smoke builds succeed with zero gating code. macOS signing via `CSC_LINK`/`CSC_KEY_PASSWORD`; Windows NSIS signing via `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (env-driven, no code). The workflow passes these as env to `npm run dist`; absent secrets resolve to empty strings = unsigned. *Why built-in over a hook:* no `@electron/notarize` devDep, no ESM/CJS-hook issue (the project is ESM), and the skip-when-absent behavior is upstream-maintained. *Follow-up when certs are provisioned:* the bundled standalone Node (V8 JIT) spawned by the supervisor likely needs entitlements (`com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory`) to run under hardened runtime - only relevant for signed builds; unsigned builds are unaffected. Turns `desktop-supervisor` task 4.8 into a secret-gated path rather than a blocker.

**D6 - Cache three things.** `pip` (litellm install is the heaviest step), `resources/` across runs of the same platform (predist is idempotent and skips when built), and `node_modules`/electron-builder cache. *Why:* cut 10-20 min builds toward minutes; private-repo billing.

**D7 - Release via `softprops/action-gh-release`.** On tag, attach `dist/*.dmg` and `dist/*.exe` (plus optional `latest.yml`/`*-mac.yml` for a future updater) to a Release. Artifacts also uploaded via `actions/upload-artifact` for non-tag dispatch builds. *Why:* standard, maintained, handles draft/auto-name.

## Risks / Trade-offs

- **[ABI mismatch: bundled Node vs prebuilt native addon]** -> Pin Node version (D4); add a CI assertion that the bundled Node version equals the `setup-node` version and that `better-sqlite3` has a matching prebuild. Fail fast in CI, not in a user's first chat.
- **[macOS notarization of embedded Node/Python binaries]** -> Sign + notarize the whole bundle (`afterSign` hook runs `electron-notarize`); `python-build-standalone` is generally notarization-friendly (already noted as a risk in the supervisor design). Verify with a real tagged release once certs exist.
- **[Build time / cost]** -> Caching (D6); tag/dispatch-only (D2). Expect ~10-20 min/job uncached; minutes cached.
- **[x64 mac via Rosetta]** -> The x64 build runs on the arm64 runner via Rosetta (`setup-node architecture: x64` so `npm ci` compiles native addons for the x64 ABI; `build-node.js`/`build-python-litellm.js` are arch-aware via `process.arch`). Slower than a native Intel runner, but avoids depending on the deprecated `macos-13` Intel runner. **Verified:** run 30080157584 built both arm64 (290 MB) + x64 (294 MB) dmgs green. Two sub-gotchas surfaced: electron-builder uses `--arm64`/`--x64` flags (not `--arch`), and a config `mac.target.arch: [arm64, x64]` list makes EVERY job build ALL archs (so the config arch is omitted and the flag selects).
- **[Secrets not yet provisioned]** -> Unsigned builds succeed (D5); the first tagged release can ship unsigned with a documented Gatekeeper/SmartScreen bypass until certs arrive.
- **[python-build-standalone / nodejs.org download flakes]** -> retries in the build scripts; cache `resources/` so a flaky download doesn't repeat.

## Open Questions

- Exact Node version to pin (must have better-sqlite3 prebuild coverage on both arm64 + win-x64). Propose: a current LTS, decided at apply time.
- Notarization secrets naming (`AC_PASSWORD` vs `APP-SPECIFIC-PASSWORD`) - match electron-builder docs at apply time.
- Ship a `latest.yml`/`*-mac.yml` auto-update feed now, or defer to a later `auto-update` change? (Default: defer.)
