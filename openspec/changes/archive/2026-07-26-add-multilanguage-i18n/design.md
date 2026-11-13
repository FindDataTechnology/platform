## Context

The web frontend (`web/`) is a Vite + React 19 + TypeScript SPA. Today every user-visible string is a hard-coded literal in JSX - e.g. `Sidebar.tsx` renders `"💬 Chat"`, `"Chats"`, `"+ New"`, `"No chats yet. Click \"+ New\"."`, `"Loading models…"`, `"Connected"`/`"Connecting…"`/`"Disconnected"`, `"Clear chat"`; `Composer.tsx` renders the placeholder, slash-command meta, `/help` text, drag-drop overlay, and upload toasts; `DashboardPage.tsx` and `DocumentsPage.tsx` carry dozens more. There is no i18n dependency (`web/package.json` has none). The e2e suite (Playwright, `workers: 1`) asserts a few display strings directly - notably `getByTestId("status-text")` -> `"Connected"` in `e2e/app.spec.js` and `e2e/nav-persistence.spec.js`.

Constraints: the backend stays buildless plain JS and is **not** localized in this change (server-originated strings - WS broadcasts, REST error bodies - remain English). The embedded third-party iframe UIs (`/oc-web`, `/litellm-web`) have their own i18n and are out of scope. Skill `SKILL.md` bodies are content, not localized in v1. Adding a dep must not disturb the bundled-Node ABI / `npmRebuild: false` - react-i18next is pure JS, so this is safe.

Stakeholders: end users (multi-locale UI), developers (string-extraction discipline), QA (test-assertion strategy).

## Goals / Non-Goals

**Goals:**
- Every user-visible string in the React shell resolves through react-i18next; no hard-coded display text remains in `web/src` JSX.
- Ship five locales: `en` (source), `zh-CN`, `es`, `fr`, `ja`.
- A persisted, user-selectable language with sensible browser-language detection and English fallback.
- The e2e suite continues to pass without rewriting every assertion - locale is pinned to `en` for tests.
- A build-time guard that catches missing/extra keys across locale files.

**Non-Goals:**
- Localizing the backend (`server.js` and modules) or server-originated WS/REST strings.
- Localizing the OpenConnector/LiteLLM embedded iframe UIs.
- Localizing skill `SKILL.md` bodies/descriptions.
- RTL support / Arabic (deferred; `dir` attribute reserved for future).
- Lazy-loading locales over HTTP at runtime (bundle for now; revisit if locale count or size grows).
- Number/date/relative-time formatting libraries - reuse existing `toLocaleString()` calls, optionally passing the active locale.

## Decisions

### 1. Library: react-i18next (`i18next` + `react-i18next`)
**Rationale:** Mature, the de-facto React i18n, with built-in interpolation (`{{var}}`), plurals, namespaces, fallback, and React bindings (`useTranslation`, `initReactI18next`) that trigger context-driven re-renders on locale change. The app is small but will grow; react-i18next scales without rework. Pure-JS deps - no native addons, so `npmRebuild: false` and the bundled-Node ABI are unaffected.

**Alternatives considered:**
- *Lightweight custom (React Context + flat JSON + localStorage):* zero deps, fits the project's minimal-dependency ethos. Rejected because we'd reimplement interpolation, fallback, and re-render plumbing; the savings (~2 deps) aren't worth the maintenance as the app grows.
- *react-intl (FormatJS):* strong ICU MessageFormat, but heavier and a steeper mental model; overkill without an ICU-pluralization requirement.

### 2. Resource structure: one `common` namespace, bundled, per-locale files
`web/src/locales/{en,zh-CN,es,fr,ja}/common.json`, each a flat dotted-key map. Single `common` namespace (the app isn't large enough to justify multiple). Files are **statically imported** (Vite bundles them) rather than fetched at runtime - avoids a flash-of-English and a runtime fetch dependency; five tiny files add negligible bundle weight.

**Alternatives:** `i18next-http-backend` lazy-loading - defer until bundle/loc-count pressure appears.

### 3. Key naming: flat dotted keys grouped by feature
`nav.chat`, `nav.dashboard`, `nav.documents`, `nav.openconnector`, `nav.litellm`, `nav.chats`, `nav.new`, `sidebar.noChats`, `sidebar.untitled`, `sidebar.loadingModels`, `sidebar.clearChat`, `status.connected`, `status.connecting`, `status.disconnected`, `composer.placeholder`, `composer.placeholderDisabled`, `composer.cmd.model`, `composer.cmd.new`, `composer.cmd.clear`, `composer.cmd.help`, `composer.helpHeader`, `composer.uploaded`, `composer.uploadFailed`, `composer.dropHint`, `dashboard.title`, `dashboard.refresh`, `dashboard.refreshing`, `dashboard.loadFailed`, `dashboard.retry`, `dashboard.servers`, `dashboard.activeModel`, `dashboard.provider`, `dashboard.uptime`, `dashboard.documents`, `dashboard.collections`, `dashboard.mcpTools`, `documents.*`, etc. Dynamic values use interpolation: `composer.uploaded: "Uploaded {{name}}"`.

### 4. Locale resolution: localStorage -> browser -> English
Order: `localStorage["platform.locale"]` (explicit user choice) -> `navigator.languages` / `navigator.language` best-effort match against the supported list -> `en`. Match logic: exact (`zh-CN`), then primary-subtag (`zh` -> `zh-CN`, `pt` -> not supported -> `en`). `i18next`'s `load: "languageOnly"` is **not** used (we need `zh-CN` to win over a bare `zh`), so we pre-resolve the locale ourselves and hand i18next a single resolved code. `fallbackLng: "en"` ensures any missing key falls back per-key rather than throwing.

### 5. Persistence: client-side `localStorage`, no `settings.json` change
`localStorage["platform.locale"]`. Locale is a pure UI preference - it needs no server restart and no credential handling, so it does **not** belong in the Electron `settings.json`/Preferences surface (which is for restart-on-change config). On Electron, `localStorage` persists per-origin under userData and survives restarts, satisfying the packaged-app case. Key is namespaced `platform.*` to match the project prefix.

### 6. Language switcher in the sidebar footer
A native `<select>` in the sidebar footer (near the model select / clear button), options labeled by each locale's **display name in its own language** (English, 简体中文, Español, Français, 日本語). `data-testid="locale-select"`. On change: persist to localStorage, set `document.documentElement.lang`, and call `i18n.changeLanguage` (react-i18next re-renders the tree).

### 7. `<html lang>` and `dir`
`document.documentElement.lang` is set to the resolved locale on init and on every change (a11y + correct font rendering). `dir` is left `ltr` (no RTL locale in v1); the hook sets it explicitly so adding an RTL locale later is a one-line change.

### 8. Test strategy: pin e2e to `en`, add a locale-parity build check
- **e2e:** set `localStorage["platform.locale"] = "en"` (and `document.documentElement.lang`) in `e2e/helpers.js` `prepareTempStoreDirs` / page-setup before navigation, so existing text assertions (e.g. `"Connected"`) stay valid. No production default changes.
- **Parity check:** a tiny node script `scripts/check-locales.js` (run via `npm run check:locales`, and optionally wired into `web:build`) that loads every `common.json`, asserts all locales expose exactly the same key set as `en`, and asserts no value is empty. Catches drift at build time.

**Alternative considered:** a no-hardcoded-literal ESLint rule / AST scan - rejected as brittle (hard to distinguish display text from intentional literals like emoji). Review + parity check is the pragmatic guard.

### 9. Backend strings stay English (v1)
WS error broadcasts and REST error bodies remain English. A future change can introduce keyed error codes (`{ code: "errors.model.unavailable" }`) and translate client-side; that is a cross-cutting refactor deferred from this change.

## Risks / Trade-offs

- **[Missing/extra keys in non-en locales]** -> `fallbackLng: "en"` renders the English string per-key so the UI never breaks; the `check-locales` script fails the build on key-set drift.
- **[Translation quality]** non-English strings will be placeholder-quality until native review. Mitigation: translations are isolated in JSON (no code risk); mark them as needing review in `tasks.md`; missing keys degrade to English, never to a crash.
- **[Bundle size with 5 locales inlined]** -> each `common.json` is a few hundred short strings (low KB). Acceptable for 5 locales; documented that we'd move to `i18next-http-backend` if the count or size grows.
- **[e2e text assertions break under non-en locale]** -> tests pin `en` via `localStorage`; documented as a BREAKING test-only change in the proposal.
- **[Forgetting `t()` for new strings]** -> review discipline + parity check (catches *missing* keys once a string is keyed in `en` but not elsewhere; does not catch a string never extracted at all). Mitigation: a follow-up lint can be added; acceptable residual risk for v1.
- **[Re-render cost on locale switch]** -> react-i18next re-renders the tree once per switch; negligible for this app size.

## Migration Plan

1. Add `i18next` + `react-i18next` to `web/package.json`; `npm install`.
2. Scaffold `web/src/locales/en/common.json` by extracting existing strings from each component (start with `Sidebar`, then `Composer`, chat blocks, `DashboardPage`, `DocumentsPage`, `EmbeddedServicePages` labels).
3. Add `web/src/i18n.ts` (init config + resolver + `useLanguage` hook) and mount in `main.tsx` before `<App/>`.
4. Migrate each component to `useTranslation()` + `t()`; remove literals.
5. Produce `zh-CN`, `es`, `fr`, `ja` `common.json` (placeholder-quality, review-flagged).
6. Add the sidebar locale `<select>` + persistence + `<html lang>`/`dir` updates.
7. Pin e2e locale to `en` in `e2e/helpers.js`; add `scripts/check-locales.js` + `npm run check:locales`; wire into `web:build`.
8. Verify: `npm run web:build`, `npm run test:e2e` (fast), and manually switch locales in `web:dev`.

**Rollback:** The change is additive and isolated to `web/` plus two deps and a test helper line. Revert the branch/PR. The new `localStorage["platform.locale"]` key is harmless if the feature is removed (it's simply ignored). No data migration; no schema changes.

## Open Questions

- *Native review of zh-CN/es/fr/ja translations:* needed before real release; tracked in `tasks.md` as a follow-up gate. (No code unknowns.)
- *Should the Electron Preferences window mirror the locale?* Decided **no** for v1 (localStorage + sidebar switcher suffice); can add a `locale` field to `settings.json` later if centralized control is wanted.
- *Lazy-load locales over HTTP?* Deferred; revisit if >10 locales or large resource files.
