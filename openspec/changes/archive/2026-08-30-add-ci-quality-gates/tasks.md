## 1. Fix broken gates

- [x] 1.1 Fix `web/src/components/Composer.tsx:197` type error (`Object is possibly 'undefined'`) with a real guard, not a non-null assertion; verify `cd web && npx tsc --noEmit` passes
- [x] 1.2 Add `"typecheck": "tsc --noEmit"` script to `web/package.json`
- [x] 1.3 Fix `scripts/test-chat-store-rename.mjs` zustand import to resolve via repo-relative URL/`createRequire` (no absolute paths); run `npm run test:unit` from a fresh clone path to confirm
- [x] 1.4 Change root `test:e2e:smoke` to `playwright test --project=smoke`; confirm `npm run test:e2e:smoke -- --list` selects only the 2 `@smoke` tests and never the `live` project
- [x] 1.5 Update `e2e/README.md` script documentation to match (smoke = smoke-only, live = explicit opt-in)

## 2. Lint

- [x] 2.1 Add `@biomejs/biome` devDependency and `biome.json` (recommended correctness rules; formatting/style rules off; include root JS + `web/src`)
- [x] 2.2 Add root `"lint": "biome check ."` script; run and fix/suppress findings until `npm run lint` is green (prefer minimal code fixes; `biome-ignore` with comment where a rule is a false positive)

## 3. CI workflow

- [x] 3.1 Create `.github/workflows/ci.yml`: `pull_request` + `push: main` triggers, ubuntu-latest, Node 25 via setup-node with npm cache, `PLATFORM_SKIP_WEB_BUILD=1 PLATFORM_SKIP_BUNDLE=1 npm ci`
- [x] 3.2 Add sequential steps: `npm run lint` → `npm run typecheck` (or `npm --prefix web run typecheck`) → `npm run test:unit` → `npm run check:locales` → web deps + `npm run web:build` → `npx playwright install --with-deps chromium` → `npm run test:e2e` (fast project, e2e step timeout 15m)
- [x] 3.3 Validate the workflow end-to-end on a clean runner (11 iterations to green; final: run 33199985809 — all steps ✓ in 4m34s, e2e fast 95 passed + 1 skipped in 34s. Runner findings + fixes recorded in design.md addendum: staged-file miss, root-tsc fallback, dsh CLI install, full profile-bootstrap recipe incl. jsonrpc-server/patch, pnpm/bundle pins, 180s webServer timeout, hermetic suite repair + a real ChatSessionMenu delete-dialog bug)

## 4. Wrap-up

- [x] 4.1 Add CI status badge to `README.md` (top, near version line)
- [x] 4.2 Record final gate timings in the PR description (inform future sharding decisions) — measured locally 2026-08-28: lint ~1s · typecheck ~5s · unit 147ms · locales <1s · web:build 2.1s · e2e fast 5m22s → est. CI job 8–10 min incl. install & chromium
