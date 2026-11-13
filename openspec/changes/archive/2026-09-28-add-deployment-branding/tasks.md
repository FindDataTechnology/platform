# add-deployment-branding — Tasks

## 1. Server: branding store + config surface

- [x] 1.1 Add `deployment_config` key/value table (migration v-next in `db.js`, upsert/get helpers mirroring `user_preferences`) and verify with a small hermetic script (set/get/overwrite round-trip, WAL)
- [x] 1.2 Extend `GET /api/config` (`server/routes/misc.js`) to resolve companyName/assistantName/brandIconUrl/loginFooterText as stored → env (`COMPANY_NAME`/`ASSISTANT_NAME`/`BRAND_ICON_URL`/`LOGIN_FOOTER_TEXT`) → null; verify with the server booted auth-off: env-only values served, stored values win after a write
- [x] 1.3 Add `PUT /api/config/branding` (requireAdmin gate; strings ≤200 chars, `brandIconUrl` must be `http(s)://` when non-empty; omitted = unchanged, empty string = clear) and verify: anonymous auth-off write succeeds; auth-on non-admin gets 403; invalid values 4xx with nothing persisted
- [x] 1.4 Document the four env fallbacks in `.env.example` (Branding section, resolution order: stored → env → localized default) and verify the section reads consistently with the existing `ASSISTANT_NAME` note

## 2. Logto round trip: rd + ui_locales

- [x] 2.1 In `server/logto-auth.js` `login()`: validate `rd` (relative, one leading `/`, not `//`), store it in the signed STATE_COOKIE payload, and pass `ui_locales` (≤10 chars, `/^[a-zA-Z-]+$/`) to the authorization redirect; verify with a hermetic test that the state cookie carries rd and the redirect URL contains both params
- [x] 2.2 In `callback()`: after state verification, redirect to the carried `rd` (fallback `/`) — including the invalid/absent-rd → `/` cases; verify with the hermetic test asserting the final Location for valid/invalid/missing rd
- [x] 2.3 Live probe against the deployed logto instance: full round trip with `rd=/chat/<id>` lands back on that session, and record whether the hosted page honors `ui_locales` (design open question) in the change notes

## 3. Web: config + login page

- [x] 3.1 Extend `AppConfig` (`useAppConfig.ts`) with the four branding fields + favicon injection in `main.tsx` next to the existing `document.title` block; verify manually: configured icon shows in the tab, unset ⇒ no link element (assert via DOM in a small e2e or manual dev check)
- [x] 3.4 Rework `LoginPage.tsx`: brand icon (when configured) + company-name copy interpolation + footer line when `loginFooterText` set (no footer element when unset); login link appends `ui_locales=<resolved locale>`; verify unbranded render matches current output (no icon, no footer, localized defaults)
- [x] 3.2 Add a compact `LocalePicker` to `/login` reusing the existing setLocale mechanism (localStorage `platform.locale` + `i18n.changeLanguage`); verify switching re-renders the page in the chosen language and persists across reload
- [x] 3.3 Update locale copy in all five languages (`web/src/locales/*/common.json`): login description interpolates `{{company}}` (fall back to `{{brand}}` semantics when companyName unset) + new keys for footer/admin section; verify `npm run web:build` passes the check-locales guard
- [x] 3.5 Settings admin section "部署品牌": forms for the four fields reading current effective values (`GET /api/config`) and saving via `PUT /api/config/branding`; admin-only visibility when auth on; verify save → refresh reflects new values without server restart

## 4. Desktop build branding

- [x] 4.1 Vendor the default icon: download the fd png (full size) to `build/icon.png`, verify ≥512px and committed
- [x] 4.2 `electron-builder.js`: `productName`/`artifactName` from `PRODUCT_NAME` env (default "Platform"), `icon` from the resolved path; add `scripts/fetch-build-icon.js` (ICON_URL set → download to build temp; failure → warn + vendored) and wire into `predist`; verify `node scripts/fetch-build-icon.js` with no ICON_URL no-ops and with a bogus URL warns + falls back
- [x] 4.3 `release.yml`: pass `PRODUCT_NAME`/`ICON_URL`/`COMPANY_NAME` from GitHub `vars.*` context into the build steps; verify a workflow_dispatch dry run logs the resolved values (or inspect the diff against the current matrix if secrets block a run)
- [x] 4.4 Smoke `npm run dist` locally with `PRODUCT_NAME=TestBrand`: dmg/app name carries it and the icon is the vendored one

## 5. Wrap-up

- [x] 5.1 Run the relevant e2e specs (auth/login flows) plus the unit suite; fix only regressions introduced by this change (memory: pre-existing flakes exist — confirm on HEAD before blaming this change)
- [x] 5.2 Update `openspec/changes/add-deployment-branding` notes with the 2.3 live-probe outcome, then `/opsx:sync` + `/opsx:archive`
