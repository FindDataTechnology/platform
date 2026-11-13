# add-deployment-branding

## Why

The login page is the product's front door but is hardcoded: a blank tab favicon, assistant-name interpolation where a company name reads better, no footer, and a language switcher that only exists behind login. Meanwhile every branding knob (company name, icons, footer text) is env-only — a restart to change a label, and an open-source forker must edit code to ship their own look. The jump to Logto's hosted page also drops the return URL (`rd`) and the user's locale, landing everyone back on `/` in whatever language Logto guessed.

## What Changes

- **Runtime branding store**: deployment branding fields (company name, assistant name, brand icon URL, login footer text) persisted in SQLite, editable in a Settings admin section (requireAdmin gate), env vars as first-boot fallback. `/api/config` (already auth-exempt) serves them; anonymous surfaces (login page) render them.
- **Login page polish**: language switcher on `/login`, brand icon + company name in the login card, configurable footer line, login-card copy interpolates company name instead of assistant name.
- **favicon**: `/api/config` carries the icon URL; the web injects `<link rel="icon">` at boot (same pattern as `document.title`). Unset ⇒ current behavior (no icon).
- **Logto round-trip fixes**: `/auth/login` accepts `?rd=` and carries it through the state cookie; `/auth/callback` validates it (same-origin path only) and redirects back instead of always `/`. The authorization redirect passes `ui_locales` from the browser's resolved locale.
- **Desktop build branding**: `PRODUCT_NAME` / `COMPANY_NAME` / `ICON_URL` build variables; the release pipeline downloads the icon (default: the fd COS png/svg, also vendored in-repo as fallback) and feeds electron-builder's `productName` + icon. Open-source users fork, set three variables, get their own branded dmg/exe.

## Capabilities

### New Capabilities
- `deployment-branding`: runtime-editable deployment branding — the SQLite store, admin section, env fallback, `/api/config` field contract, and how each anonymous/authenticated surface consumes them (login card, footer, favicon, tab title).

### Modified Capabilities
- `auth`: login page gains a language switcher and brand fields (requirement: in-application login experience); the Logto round trip honors `rd` return URLs and passes `ui_locales` (requirement: public identity and SSO configuration — extended to cover return-URL carry-through).

## Impact

- **Server**: `db.js` (new branding key/value rows or a dedicated table — same pattern as `user_preferences`), `server/routes/misc.js` (`/api/config` fields + admin GET/PUT routes for branding), `server/logto-auth.js` (rd carry-through + `ui_locales`).
- **Web**: `web/src/hooks/useAppConfig.ts` (extended config type), `web/src/main.tsx` (favicon injection), `web/src/pages/LoginPage.tsx` (brand fields, footer, language switcher), Settings admin section component, locale files (5 languages).
- **Desktop/build**: `electron-builder.js` (productName/icon wiring), `scripts/build-*.js` or a small pre-dist step (icon download), `.github/workflows/release.yml` (three build variables), vendored default icon under `build/`.
- **Non-goals**: no in-app editing of Logto's hosted sign-in page (console-side config only), no app-shell footer (login page only), no multi-tenant per-user branding.
