# add-deployment-branding — Design

## Context

`GET /api/config` already exists as an auth-exempt boot endpoint (`server/routes/misc.js:96`) serving `documentsEnabled` + `assistantName` (env-only, `ASSISTANT_NAME`). The web already fetches it before first paint (`web/src/hooks/useAppConfig.ts`, 1.5s timeout, fail-open) and applies `document.title`. The MCP-config feature established the stored-config-overrides-env pattern in SQLite (`db.js`). The Logto flow (`server/logto-auth.js`) already carries `state`/`nonce`/`codeVerifier` in a signed state cookie — it just ignores `rd`. i18n resolves locale at boot from localStorage → browser languages → `en`; the switcher component lives only in Settings → General (`GeneralSection.tsx`).

## Goals / Non-Goals

**Goals:**
- One branding source with two writers: SQLite (admin UI) over env (first boot / desktop settings.json).
- Zero new deps, zero new services. Fits the single-process model and the graceful-degradation convention.
- Fork-friendly desktop build: brand comes from build variables + downloadable icon, defaults vendored.

**Non-Goals:**
- No editing of Logto's hosted sign-in page from this app (console-side config only).
- No app-shell footer (login page only — user decision).
- No per-user / multi-tenant branding (deployment-wide, single value set).
- No icon upload endpoint — `brandIconUrl` is a URL field, the browser fetches it from wherever it points (typically the deployer's own CDN/COS).

## Decisions

### D1: Branding storage — reuse the key/value preference store pattern, not a new table

`db.js` has `user_preferences` (key/value, single-user). Branding is deployment-wide, so a parallel small table `deployment_config (key TEXT PRIMARY KEY, value TEXT, updated_at)` — or four rows in a generic `app_config` — both work. Chosen: **one generic `deployment_config` key/value table** (4 rows now, room for later knobs without migrations), same upsert helper shape as `user_preferences`. Alternative rejected: dedicated typed columns — a migration per future knob, no benefit at this size.

Env fallback resolution happens in the `/api/config` handler at read time: `db.getDeploymentConfig(key) ?? process.env.X ?? null`. No write-back of env into the DB (keeps "stored wins" trivially true and the DB free of echoes).

Length bounds: 200 chars for all four fields (footer might want more; 200 is still generous for a one-liner; documented in the route validation).

### D2: Admin mutation route — one PUT, admin-gated, colocated with `/api/config`

`PUT /api/config/branding` in `server/routes/misc.js`, body `{companyName?, assistantName?, brandIconUrl?, loginFooterText?}`, all optional, `null`/absent = leave unchanged... **Correction — simpler contract:** PUT is full-replace of provided fields; omitted fields are unchanged; empty string clears a field back to fallback. Validation: strings ≤ 200 chars; `brandIconUrl` must parse as `http(s)://` when non-empty. Gate: `ctx.requireAdmin` (open when auth off — matches `/api/catalog/refresh`'s pattern). Alternatives rejected: PATCH (no partial semantics needed beyond "omitted = unchanged", PUT reads fine); a separate settings route module (one route doesn't earn a file).

The web Settings surface gets a new "部署品牌 / Deployment branding" section (admin-visible when auth on; visible always when auth off, same visibility rule the other admin sections use).

### D3: Favicon — runtime `<link>` injection, not an `/favicon.ico` file

`main.tsx` already applies `document.title` after `loadAppConfig()`; favicon rides the same block: create/replace `<link rel="icon" href={brandIconUrl}>`. No server-side icon hosting, no proxy route. Unset ⇒ no link element (browsers then fall back to default `/favicon.ico` 404 → blank tab, which is today's behavior). Alternative rejected: server `GET /favicon.ico` proxying the configured URL — extra route and caching headaches for zero benefit; the browser fetching the CDN URL directly is simpler and the URL is deployer-controlled, not user-controlled, so it is not a CSP/security surface.

### D4: `rd` carry-through — piggyback on the existing state cookie

`login()` reads `req.query.rd`, validates (relative path, one leading `/`, not `//`), stores it inside the existing signed `STATE_COOKIE` payload alongside `state`/`nonce`/`codeVerifier`; `callback()` reads it back after state verification and redirects there (fallback `/`). No new cookie, no new crypto surface, expires with the same 10-min TTL. `ui_locales`: `login()` accepts `req.query.ui_locales` (bounded: known locale list on the server is overkill — accept any value ≤ 10 chars matching `/^[a-zA-Z-]+$/` and pass through; Logto ignores unknown values).

### D5: Login-page language switcher — reuse, don't fork, the existing switcher

`GeneralSection`'s switcher logic is `setLocale` (localStorage `platform.locale` + `i18n.changeLanguage`). Extract or re-render a compact variant on `/login` (a small `LocalePicker` next to the login card). The login URL gains `&ui_locales=<current>` so the hosted page opens in the picked language. Alternative rejected: `<html lang>`-based negotiation on the server — the SPA is static-served; client-side resolution already works.

### D6: Desktop build — vendored default + optional download, three variables

- `build/icon.png` vendored (download the fd icon once, commit it; ≥512px png — electron-builder derives mac icns + win ico from it).
- New `scripts/fetch-build-icon.js` (or a step inside `predist`): if `ICON_URL` is set, download to a temp path and point the builder at it; on failure warn + use vendored. No cache-key change needed: the icon is build input, not a compiled artifact.
- `electron-builder.js` reads `PRODUCT_NAME` env (default `"Platform"`) for `productName` + `artifactName` prefix; `icon` points at the resolved icon path. `COMPANY_NAME` feeds the win nsis publisher-ish metadata if trivially available (win `legalTrademarks`/mac nothing mandatory).
- `release.yml` passes `PRODUCT_NAME`/`ICON_URL` through from repo/workflow variables (GitHub `vars.` context — set per fork without editing the workflow).
- Alternative rejected: committing a per-fork config file — env vars in the workflow UI are the fork-friendliest (no code edit at all).

### D7: `ui_locales` from the client — the login link appends it

`LoginPage` already builds `withReturnTo(auth.loginUrl, href)`. Extend `useAuth`'s helper (or the page) to also append `ui_locales=i18n.language` for logto mode. Server treats it as optional passthrough (D4).

## Risks / Trade-offs

- [Cross-origin icon URL is deployer-controlled but could 404 later] → Favicon injection is best-effort; a dead URL shows the default tab icon. The admin route validates URL shape only, not reachability (runtime liveness is not our problem).
- [Branding read on every `/api/config` hit adds SQLite reads] → `/api/config` is a boot/health endpoint (low QPS); plain `get()` calls, no caching needed (ponytail: add a cache if a probe ever hammers it).
- [Stored branding survives a `.env` change the operator expects to win] → Resolution order documented in `.env.example` + admin UI shows current effective values; changing env only affects fields with no stored value.
- [mac icon conversion needs ≥512px source] → Vendored fd png is fetched at full size; `fetch-build-icon.js` warns if the downloaded png is <512px but proceeds (electron-builder fails loudly on unusable input anyway).
- [`rd` open-redirect is the classic footgun] → Validation is strict relative-path-only (mirrors `AUTH_LOGIN_PATH` validation in the auth spec); anything else falls back to `/`.

## Migration Plan

1. Server: table + routes first (additive; `/api/config` gains fields — old clients ignore unknown fields, supervisor health probe unaffected).
2. Web: config type + favicon + login page (no API break; `assistantName` semantics unchanged).
3. Logto `rd`/`ui_locales`: additive query params, safe to deploy while old frontends still omit them.
4. Build: vendored icon + variables — only affects `npm run dist`, dev untouched.
Rollback: each step is independent; revert the commit(s). No data migration (empty table = env-only behavior).

## Open Questions

- Whether Logto's hosted page honors `ui_locales` in practice for this tenant — verified during implementation task 9.2 live probe; if ignored, the param is harmless and the fallback is the Logto console's default-language setting.
