# add-desktop-windows-hardening

## Why

The first Windows release round shipped installers that were broken in four
different ways, and every round of that round passed its CI checks while the
user still saw a broken app:

1. The installer offered no directory choice, no progress, no cancel and no
   completion page — the NSIS options were written under the Windows platform
   key, where the packager silently ignores them.
2. The packaged agent runtime could not boot: its components are installed by
   the package manager as peers that no manifest declares, so the packager's
   dependency-edge walk dropped them.
3. The agent profile could not resolve its bridge plugins: they resolve only
   from the profile's own module directory, which nothing provisions on a clean
   machine.
4. The window stayed black: the backend bound `localhost` (resolved to `::1`
   only) while the window loaded `127.0.0.1`, and the health probe — written
   against the same hostname — stayed green throughout.

Underneath all four sits one repeated failure mode: **the checks were proxy
indicators measured in an environment unlike the user's**. A process exists, a
port answers, a screenshot has non-background pixels — none of which means the
user sees the app.

## What changes

- Health probes target the address the backend actually bound; the desktop
  backend binds IPv4 loopback.
- The window is revealed only after it paints, with bounded retries and a
  forced-reveal fallback, and the packaged main process mirrors its logs to a
  user-readable file.
- The app gains an opt-in in-app render self-test: it waits for load, reads
  live DOM state, captures the renderer's own frame buffer, writes a report and
  screenshot, and exits 0/1.
- The Windows install smoke asserts that self-test, probes the window's exact
  URL, and no longer accepts display-wide screenshots as rendering evidence.
- The packaging closure covers peer-only and dynamically loaded runtime
  packages; the app maintains the profile's module links and clears stale
  entries.
- Readiness reports healthy only when the agent runtime actually initialized.

## Impact

- specs: `desktop-supervisor`, `installer-distribution`, `release-pipeline`
- code: `electron/main.js`, `electron/smoke-selftest.js`,
  `supervisor/descriptors.js`, `dsh-profile.js`, `server.js`,
  `electron-builder.js`, `package.json`, `scripts/verify-bundle.js`,
  `.github/workflows/win-install-smoke.yml`
