## 1. Setup & dependencies

- [x] 1.1 Add `i18next` and `react-i18next` to `web/package.json` `dependencies` (latest stable).
- [x] 1.2 Run `npm install` in `web/` (or repo root `npm install`) and confirm both resolve without native/binary rebuilds.
- [x] 1.3 Create the directory tree `web/src/locales/{en,zh-CN,es,fr,ja}/` and a placeholder `common.json` in each.

## 2. i18n core: init, resolver, hook

- [x] 2.1 Create `web/src/i18n/config.ts` exporting `SUPPORTED_LOCALES` (`["en","zh-CN","es","fr","ja"]`), `LOCALE_DISPLAY_NAMES` (endonyms: English, 简体中文, Español, Français, 日本語), `DEFAULT_LOCALE` (`en`), and `STORAGE_KEY` (`platform.locale`).
- [x] 2.2 Implement `resolveLocale()` in `web/src/i18n/config.ts`: `localStorage[platform.locale]` -> `navigator.languages`/`navigator.language` best match (exact then primary-subtag) -> `en`.
- [x] 2.3 Create `web/src/i18n/index.ts` that imports all five `common.json` bundles, calls `i18next.use(initReactI18next).init({ resources, lng: resolveLocale(), fallbackLng: "en", defaultNS: "common", interpolation: { escapeValue: false } })`, and exports the initialized `i18n` instance.
- [x] 2.4 Implement `useLanguage()` hook (`web/src/i18n/useLanguage.ts`): returns `{ locale, locales, changeLocale }`; `changeLocale(l)` persists to `localStorage`, sets `document.documentElement.lang` + `dir="ltr"`, and calls `i18n.changeLanguage(l)`.
- [x] 2.5 Mount i18n in `web/src/main.tsx`: import `./i18n` (side-effect init) before rendering `<App/>`; set `document.documentElement.lang` to the resolved locale on first paint.

## 3. Extract English strings to `en/common.json`

- [x] 3.1 Add `nav.*` keys: `chat`, `dashboard`, `documents`, `openconnector`, `litellm`, `chats`, `new`, extracted from `Sidebar.tsx` (strip emoji icons or keep them in JSX — decide consistently).
- [x] 3.2 Add `sidebar.*` keys: `noChats`, `untitled`, `loadingModels`, `clearChat`, `brand`.
- [x] 3.3 Add `status.*` keys: `connected`, `connecting`, `disconnected`.
- [x] 3.4 Add `composer.*` keys: `placeholder`, `placeholderDisabled`, `helpHeader`, `cmd.model`, `cmd.new`, `cmd.clear`, `cmd.help`, `uploaded` (`Uploaded {{name}}`), `uploadFailed` (`Upload failed: {{message}}`), `dropHint`.
- [x] 3.5 Add `chat.*` keys from `AssistantTurn`, `ToolBlock`, `ThinkingBlock`, `SkillBlock`, `UserTurn`, `Toast` (tool labels, thinking fold labels, toast generic messages).
- [x] 3.6 Add `dashboard.*` keys: `title`, `refresh`, `refreshing`, `loadFailed` (`Failed to load status: {{error}}`), `retry`, `servers`, `activeModel`, `provider` (`Provider: {{name}}`), `uptime` (`Uptime: {{sec}}s`), `documents`, `collections` (`Collections: {{count}}`), `mcpTools`, `none`.
- [x] 3.7 Add `documents.*` keys across `DocumentsPage.tsx`: `title`, `loading`, `disabled`, `ingest.*` (file/text/url labels, submit), `list.refresh`, `list.empty`, `list.count` (`Documents ({{count}})`), `content.*`, `query.*`, `collection.*`, `status.ready/indexing/queued/error`.
- [x] 3.8 Add `embedded.*` keys from `EmbeddedServicePages.tsx` (OpenConnector/LiteLLM wrapper loading/empty labels).

## 4. Migrate components to `useTranslation()` + `t()`

- [x] 4.1 `Sidebar.tsx`: replace nav labels, "Chats", "+ New", empty-state, "Loading models…", status labels, "Clear chat", "Untitled" with `t()` calls; keep `data-testid` attributes unchanged.
- [x] 4.2 `Composer.tsx`: replace placeholder (incl. disabled variant), slash-command META descriptions, `/help` output, drag-drop overlay, and upload toasts with `t()` + interpolation.
- [x] 4.3 `AssistantTurn.tsx`, `ToolBlock.tsx`, `ThinkingBlock.tsx`, `SkillBlock.tsx`, `UserTurn.tsx`: replace visible labels with `t()`.
- [x] 4.4 `Toast.tsx`: replace any hard-coded toast text with `t()`.
- [x] 4.5 `DashboardPage.tsx`: replace heading, refresh button states, error block, and all section headings/values with `t()` + interpolation.
- [x] 4.6 `DocumentsPage.tsx`: replace all headings, empty states, ingest form labels, and status badges with `t()`; pass `i18n.language` to `toLocaleString()` where dates are formatted.
- [x] 4.7 `EmbeddedServicePages.tsx`: replace wrapper labels (loading/empty) with `t()` (do NOT touch the iframe internals).
- [x] 4.8 Grep `web/src` for remaining JSX text nodes / string-literal display props (`placeholder`, `aria-label`, `title`, `>text<`) and convert any leftovers.

## 5. Translations (placeholder-quality, review-flagged)

- [x] 5.1 Produce `zh-CN/common.json` for every key in `en/common.json`.
- [x] 5.2 Produce `es/common.json` for every key.
- [x] 5.3 Produce `fr/common.json` for every key.
- [x] 5.4 Produce `ja/common.json` for every key.
- [x] 5.5 Mark all non-English files with a top-of-file note `// REVIEW: placeholder translations — needs native review before release` (or a sibling `REVIEW.md`) so reviewers know they are not final.

## 6. Language switcher + persistence

- [x] 6.1 Add a `<select data-testid="locale-select">` to the `Sidebar.tsx` footer listing `SUPPORTED_LOCALES` by endonym; bind to `useLanguage().locale` and call `changeLocale` on change.
- [x] 6.2 Verify locale persists across reload (`localStorage["platform.locale"]`) and is re-applied on init.
- [x] 6.3 Verify `document.documentElement.lang` and `dir` update on locale switch and on initial load.

## 7. Tests & build guards

- [x] 7.1 Pin the e2e locale to `en` in `e2e/helpers.js` (set `localStorage["platform.locale"]="en"` before first navigation) so existing text assertions (`"Connected"`, etc.) remain valid.
- [x] 7.2 Update any e2e test that depends on a locale-specific default to honor the pinned locale; add a smoke test that switches to `zh-CN` and asserts a known string renders in Chinese (e.g. `status-text` -> the zh-CN value).
- [x] 7.3 Create `scripts/check-locales.js`: load every `web/src/locales/*/common.json`, assert each locale's key set equals `en`'s, and assert no value is empty; exit non-zero on drift.
- [x] 7.4 Add `"check:locales": "node scripts/check-locales.js"` to the root `package.json` scripts; wire it into `web:build` (or the `predist` chain) so a drifted bundle fails the build.

## 8. Verify

- [x] 8.1 `npm run web:build` succeeds and `check:locales` passes.
- [x] 8.2 `npm run test:e2e` (fast suite) passes with the locale pin.
- [x] 8.3 Manual: `npm run web:dev` + backend on :3000; cycle every locale in the switcher and confirm all visible strings translate with no raw keys or English bleed-through.
- [ ] 8.4 Native-speaker review sign-off for `zh-CN`, `es`, `fr`, `ja` (gate before real release; may be deferred post-merge).
