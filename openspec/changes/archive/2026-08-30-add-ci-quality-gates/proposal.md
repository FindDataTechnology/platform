## Why

Nothing validates this repository on pull requests today: the only GitHub workflows are `docker-deploy` (push to main) and `release` (tags), neither of which runs tests, lint, or typecheck. Meanwhile three existing gates are silently broken — `web/` fails `tsc --noEmit` (`Composer.tsx:197`) but ships because `vite build` skips tsc, `scripts/test-chat-store-rename.mjs:17` hardcodes an absolute `/Users/chengsishi/...` path so `test:unit` only passes on one machine, and `test:e2e:smoke` actually runs ALL Playwright projects including the `live` suite against a remote k8s service. The upcoming refactor/perf work (server split, persistence unification) is unsafe to attempt without working gates; this change makes CI exist and pass, and is sequenced first of four optimisation changes.

## What Changes

- Fix the three broken gates so they can gate:
  - Fix `web/src/components/Composer.tsx:197` type error and add a `typecheck` script to `web/package.json` (`tsc --noEmit`), so type errors no longer hide behind `vite build`.
  - Fix `scripts/test-chat-store-rename.mjs` to resolve `zustand` via a relative path / `createRequire` instead of the hardcoded absolute path.
  - Repair e2e script naming: `test:e2e:smoke` must run ONLY the `@smoke`-tagged offline-capable subset (never the `live` project); `live` stays behind explicit `test:e2e:live*` scripts.
- Add `.github/workflows/ci.yml` triggered on `pull_request` + `push` to main that runs, in order: lint → typecheck → `test:unit` → `check:locales` → `web:build` → `test:e2e` (`--project=fast`, Playwright chromium, self-contained server on :3100, no secrets required).
- Introduce minimal lint: Biome (single tool, zero-config-friendly) covering root JS + web TS/TSX, with a lenient initial ruleset so the existing codebase passes without a mass reformat.
- Pin CI to Node 25 (the npm-11 lockfile requires it; matches `release.yml` and `Dockerfile`) and use `PLATFORM_SKIP_WEB_BUILD=1` + `PLATFORM_SKIP_BUNDLE=1` during `npm ci`, building `web/dist` explicitly before e2e.
- Add CI status badge to README.

## Capabilities

### New Capabilities
- `ci-pipeline`: PR-gating continuous integration — jobs, triggers, ordering, and the requirement that every gate is green on main.

### Modified Capabilities
- `e2e-testing`: script semantics change — the smoke script must be offline/deterministic and must never reach the live remote service; live testing remains opt-in via explicit scripts.

## Impact

- **Code fixes**: `web/src/components/Composer.tsx` (one type error), `scripts/test-chat-store-rename.mjs` (import resolution).
- **Scripts**: root `package.json` (`test:e2e:smoke` repair, possibly `typecheck`), `web/package.json` (add `typecheck`).
- **New files**: `.github/workflows/ci.yml`, Biome config (`biome.json`), devDependency `@biomejs/biome`.
- **No behavior change** to runtime code paths beyond the Composer type fix; e2e configs untouched (the `fast` project already runs isolated on :3100 with temp store dirs).
- Known constraints feeding design: `web/dist` is gitignored so CI must build it before e2e; `postinstall` must be skipped via env flags; `smoke` project spends real LLM tokens and needs secrets, so CI runs `fast` only.
