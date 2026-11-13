## Context

The repo has good local gates that nothing enforces: 30 unit tests (`node:test`, self-contained, ~0.2s), a locale-parity checker (5 locales × 235 keys), a strict `web/tsconfig.json`, and a 96-test offline Playwright project (`fast`) that boots its own server on :3100 with throwaway store dirs. But no workflow runs on `pull_request`; `web/` currently fails `tsc` (hidden because `vite build` doesn't typecheck); one unit test only runs on the original author's machine; and the `smoke` npm script accidentally launches the remote-k8s `live` suite. Release (`release.yml`) and deploy (`docker-deploy.yml`) build artifacts regardless of code health.

Hard constraints discovered during exploration:
- `npm ci` requires Node 25 / npm 11 (lockfile format; documented in `release.yml:74-79`, `Dockerfile:14-20`).
- `postinstall` builds `web/dist` + clones/builds bundled resources (network git+curl) — must be skipped in CI via `PLATFORM_SKIP_WEB_BUILD=1 PLATFORM_SKIP_BUNDLE=1`, then `web/dist` built explicitly.
- E2E needs `web/dist` because `server.js:1259` serves it via `express.static` with SPA fallback.
- `fast` project needs no secrets (server degrades gracefully without LLM key; helpers.js sets `OPENCONNECTOR_BASE_URL=""` to skip a ~30s OC retry); `smoke` spends real LLM tokens; `live` needs a reachable remote service.
- No lint tooling exists anywhere (no eslint/prettier/biode config; no husky).

## Goals / Non-Goals

**Goals:**
- Every PR and main-branch push runs: lint → typecheck → unit → locales → web build → e2e `fast`, all without secrets.
- The three broken gates are fixed at the source (not worked around in CI config).
- Lint exists but does not demand a mass reformat of the existing ~16k lines.

**Non-Goals:**
- No coverage thresholds, no pre-commit hooks, no Dependabot/CODEOWNERS (can layer later).
- No `smoke`/`live` in CI (they need paid secrets/reachability; remain local/opt-in scripts).
- No changes to `docker-deploy.yml`/`release.yml` beyond optionally making deploy depend on CI via existing `paths` triggers (kept out of scope to avoid coupling deploys to a new workflow during rollout).
- No frontend unit-test framework introduction.

## Decisions

**D1 — Single `ci.yml` job with sequential steps, not a job matrix.** The whole gate chain is ~5–10 min (e2e `fast` dominates at an estimated 3–8 min serial). A matrix would re-install deps per job (~2 min each) to shard a suite that's already sequential (`workers: 1` by design — shared agent session). One ubuntu runner, npm cache via `actions/setup-node`, sequential steps with fail-fast.

**D2 — Biome over ESLint+Prettier.** One dependency, one config, first-class TS/TSX + JSON, fast enough to not need caching. Initial config: recommended rules with stylistic/format rules set to "off" (or `format.enable: false`) so the existing code passes without reformatting; `lint.correctness` rules on. Alternative rejected: ESLint with `--max-warnings` games and per-directory configs — more moving parts for a codebase with zero lint history; the point is catching bugs/typos, not style enforcement.

**D3 — Typecheck gate at `web/` only, via a new `typecheck` script (`tsc --noEmit`).** Root has no tsconfig (typescript is a root devDep only). `web/tsconfig.json` is already strict. `vite build` continues to not typecheck (that's Vite's default); CI runs typecheck as its own step so failures are legible. The existing `Composer.tsx:197` `Object is possibly 'undefined'` gets a real fix, not a `!`.

**D4 — Unit-test path fix via `createRequire` + relative resolution.** `test-chat-store-rename.mjs` imports `zustand/esm/vanilla.mjs` from `web/node_modules`. Fix: resolve through `new URL('../web/node_modules/zustand/esm/vanilla.mjs', import.meta.url)` (or `createRequire` from `web/package.json`) — works from any checkout path. Also silence its intentional failed-import of the TS reducer with a comment, not a try/catch swallow change.

**D5 — `test:e2e:smoke` = `playwright test --project=smoke`, never bare `playwright test`.** Bare invocation selects all three projects (fast+smoke+live). Smoke needs LLM secrets so it stays out of CI but must at least be *honest*: it now runs exactly the 2 `@smoke` tests. `live` remains reachable only via `test:e2e:live`/`test:e2e:live:smoke`. Update `e2e/README.md` which documents the old behavior.

**D6 — CI Node 25 + skip flags, mirroring release.yml.** `actions/setup-node@v4` with `node-version: 25`, `cache: npm`. Install step: `PLATFORM_SKIP_WEB_BUILD=1 PLATFORM_SKIP_BUNDLE=1 npm ci`. Then `npm run web:install && npm run web:build` (web deps needed for `web:build`; `web:build` includes `check:locales` but CI runs `check:locales` as an explicit earlier step for clearer failure attribution). Playwright chromium via `npx playwright install --with-deps chromium`.

**D7 — Badge + trigger scope.** Workflow triggers: `pull_request` (all branches) and `push` to `main`, with the same `paths` filter family as `docker-deploy.yml` minus the k8s exclusion nuance (CI can run on any source change; keep it simple — no paths filter, cheap enough). README gets the badge line.

## Risks / Trade-offs

- [Biome's `correctness` set may still flag existing code] → First CI run is expected to surface a handful of findings; task list includes "make lint green with minimal, safe code fixes" as an explicit step, with `biome-ignore` comments allowed as escape hatch (but no blanket rule disabling beyond format).
- [Serial e2e in CI could exceed runner patience if boot is slow (cold start ~50s documented in supervisor)] → Playwright `webServer` has its own generous timeout; e2e step timeout set to 15 min initially; if chronically slow, shard by spec file later (non-goal now).
- [`--project=smoke` needs secrets that CI won't have] → Correct, and fine: smoke is for local/pre-release verification only; CI's e2e step pins `--project=fast`.
- [Fixing Composer.tsx:197 touches runtime code under a "CI" change] → It's a one-line type-level fix (optional chain or guard); the e2e `fast` suite covers the Composer paths (composer/chat-polish specs), so risk is contained; shipping a known-red typecheck as the new gate's baseline is worse.
- [Two workflows push to main-ish paths (docker-deploy also runs on push to main)] → They're independent; docker-deploy has `[skip ci]` commit-backs and its own concurrency group. No coupling added.

## Migration Plan

1. Land gate fixes (Composer type error, unit-test path, smoke script) — each independently verifiable locally (`npx tsc --noEmit` in web/, `npm run test:unit`, `npm run test:e2e:smoke -- --list`).
2. Add Biome + make `npx biome check .` green.
3. Add `ci.yml`; validate via `workflow_dispatch` on a branch before relying on `pull_request`.
4. Add README badge. Rollback = delete `ci.yml`; the gate fixes remain valuable standalone.

## Open Questions

- None blocking. (Later, optionally: make `docker-deploy.yml` gate on CI success — deferred by D7.)

## Implementation Notes (deviations from design, 2026-08-28)

- **D4 amended**: the unit-test fix removed the zustand/`useChatStore` imports entirely instead of re-pathing them — they were dead (never referenced by any test in the file), and a relative-path import would still have required `web/node_modules` to exist before `web:install` in the CI step order. Deletion fixes both the machine-dependence and the ordering hazard.
- **D2 amended**: initial Biome config also disables the `a11y` and `complexity` rule groups alongside style/format. A11y (~25 findings: `useButtonType`, label/role annotations across ~30 JSX files) is UI churn beyond this change's no-mass-reformat mandate — flagged for a future dedicated a11y-hardening change; complexity findings (optional chaining rewrites) are style-adjacent. Correctness + suspicious + security groups are ON and green.
- **Lint green-up removed genuinely dead code** beyond the three gate fixes: write-only `streamedTextThisTurn`/`mcpPending`/`docByStatus` + never-called `throttleDashboardUpdate` in server.js; unused `#epoch`/`#onCrash` private fields in dsh-bridge.js (the epoch-guard comment described behavior that was never implemented); `pythonBinPath` chain in supervisor/descriptors.js; assorted unused imports/vars in e2e specs and electron preferences. All deletions verified write-only by grep before removal; full e2e fast suite green afterward.

## Implementation Notes addendum — runner validation findings (2026-08-29)

Task 3.3's clean-runner validation surfaced seven environment gaps, each fixed and verified:

1. **Unstaged file**: the unit-test fix missed its first commit; runner lint caught it (gate worked as designed).
2. **tsc resolution**: `npm --prefix web run typecheck` resolves `tsc` from the ROOT `typescript@7` devDep when `web/node_modules` is absent (TS7 rejects web's tsconfig). CI now runs `web:install` before typecheck. Root typescript@7 remains a latent footgun (candidate cleanup).
3. **dsh runtime absent on runners** (`spawn dsh ENOENT`): install `@deepseek-ai/dsh@0.1.1-rc.2` globally (matches the homebrew/dev install).
4. **Profile bootstrap is undocumented anywhere** — server.js only patches `~/.dsh/profiles/platform`; fresh machines cannot boot. Verified recipe (reproduced locally with an isolated `$HOME`): `dsh plugin --profile platform add @deepseek-ai/dsh-base@0.1.1-rc.2` (fails at pnpm stage but initializes the profile and records the bundle) → allowlist native builds via `pnpm.onlyBuiltDependencies` (node-pty, koffi, protobufjs, @google/genai, dsh-subprocess-local) → complete with `pnpm install` → `pnpm add @deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5 @deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2` (the jsonrpc server is NOT in the dsh-base bundle; it imports sdk-protocol without declaring it) → write `cordis.patch.yml` inserting `sdk-jsonrpc-server`. Without the last two steps the runtime spawns but never answers `initialize` — the dev profile had these hand-installed, which is why only fresh machines hung. Pinning matters: unpinned bundle resolves 0.0.1-rc.1 (dep `dsh-user-interaction` is unpublished → 404), and unpinned pnpm resolves 11.x (ignores package.json settings).
5. **webServer boot timeout**: server.js listens only after dsh init; raised to 180s.
6. **The "fast" suite was never hermetic** — 22 tests depended on the developer's `.env` (LLM key → built-in provider card/model list), gitignored `agents.json` (apps tab), `mcp.json` (startup MCP badges), or had drifted from the `/mcp`+`/skills` page split (recorded "passed" runs predate it; earlier local "green" runs were masked by pipe-to-tail exit codes). Repairs: `e2e/seed-fixtures.js` in the webServer command (Playwright boots the server BEFORE globalSetup — ordering matters), dummy-LLM env gaps, `VITE_E2E_SEAM=1` build exposing `window.__chatStore` (release builds never set it), `waitForIdle` helper (composer autogrow makes click-stability never settle while a turn streams), and spec updates to current UI.
7. **Real product bug caught by the suite**: `ChatSessionMenu.handleDeleteClick` called `onClose()` (Sidebar unmounts the menu) destroying `confirmOpen` before the delete-confirm dialog rendered — delete-via-context-menu was dead for every user. Fixed by keeping the component mounted while the dialog is open.

Final hermetic numbers: **95 passed / 1 skipped / 0 failed in 1.3m locally** (was 5.4m with retries); CI job ~10 min. Residual observations for later changes: legacy `sessions-store/` migration reads unredirected paths (e2e boots imported 39 real legacy sessions in one probe); `docker-deploy.yml` fails at its first step for missing `HARBOR_*` secrets (pre-existing, affects deploys not CI).
