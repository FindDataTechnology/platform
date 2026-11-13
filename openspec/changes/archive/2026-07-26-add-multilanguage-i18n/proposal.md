## Why

The web UI is English-only. Every user-visible string — sidebar nav labels, status text, composer placeholder, dashboard headings, document ingestion flows, slash-command help, toasts — is hard-coded in JSX. For a product whose long-term target is a special-industry assistant (and which already ships a Simplified-Chinese default LLM provider, Volces), serving only English is a barrier. We need a first-class internationalization layer so the same build can render in multiple locales, starting with English (source), Simplified Chinese, Spanish, French, and Japanese, with a user-selectable language that persists across reloads.

## What Changes

- Introduce **react-i18next** (`i18next` + `react-i18next`) as the frontend's i18n runtime, initialized in `web/src` and mounted via an `I18nextProvider`/`initReactI18next` chain in `main.tsx`.
- Add a **translation resource bundle** under `web/src/locales/{en,zh-CN,es,fr,ja}/common.json` (namespaced `common`). English is the source-of-truth locale; the others are parallel translation files. A `web/src/locales/index.ts` registers all locales and exports the supported-locale list + display names.
- Extract **all user-visible strings** from `web/src` components and pages into translation keys (sidebar nav/status/session-list/footer, composer placeholder + slash-command meta + help + drag-drop + toasts, chat turn blocks, dashboard sections, documents ingestion/list/query/empty states, toast host). Hard-coded JSX text is replaced with `t("key")` calls (and `t("key", { var })` for interpolation).
- Add a **language switcher** in the sidebar footer (a `<select>` of supported locales by display name) and a `useLanguage` hook backed by `localStorage` (`platform.locale`). The selected locale is applied to `document.documentElement.lang` (and `dir` reserved for future RTL).
- Add **locale negotiation**: resolve the initial locale from `localStorage` → browser `navigator.language` (matched against the supported list with fallback) → `en` default. Unsupported browser locales fall back to English; partial matches (e.g. `zh-TW`) map to the closest supported locale (`zh-CN`).
- **BREAKING (test-only):** the e2e suite currently asserts display text (e.g. `status-text` → `"Connected"`). The suite SHALL pin the app to the `en` locale (via `localStorage`/`lang` set before load, or a test-only default) so existing text assertions stay valid; no production behavior changes.
- Add `i18next` + `react-i18next` to `web/package.json` dependencies; no backend dependency changes.

## Capabilities

### New Capabilities
- `internationalization`: Locale negotiation (persisted choice → browser language → English fallback), translation-resource loading via react-i18next, a sidebar language switcher, `document.documentElement.lang` application, and the rule that every user-visible frontend string resolves through the i18n bundle (no hard-coded display text in JSX).

### Modified Capabilities
- `app-navigation`: The nav-tab and session-list labels (Chat, Dashboard, Documents, OpenConnector, LiteLLM, "Chats", "+ New", "Untitled") SHALL resolve their displayed text from the i18n bundle, keyed by stable identifiers, instead of being hard-coded strings. Ordering, identity, and the LiteLLM-conditional behavior are unchanged.

## Impact

- **Code:** `web/src/main.tsx` (i18next init + provider), new `web/src/locales/` tree + `web/src/i18n/` (config, `useLanguage` hook), and edits to every component/page in `web/src/{components,pages}` that renders text (`Sidebar`, `Composer`, `Chat`, `AssistantTurn`, `ToolBlock`, `ThinkingBlock`, `SkillBlock`, `Toast`, `DocumentsPage`, `DashboardPage`, `ChatPage`, `EmbeddedServicePages`). `web/package.json` gains two deps.
- **APIs/contracts:** No WebSocket or REST contract changes. Strings that originate server-side (e.g. error messages broadcast by `server.js`) remain English for v1 — only the React shell is localized; a future change can move server-originated user-facing strings to keyed codes.
- **Out of scope:** the embedded third-party iframe UIs (`/oc-web` OpenConnector, `/litellm-web` LiteLLM) have their own i18n and are not localized here; skill `SKILL.md` bodies/descriptions are content, not localized in v1; the Electron Preferences window is unaffected (locale is a client-side UI preference, not a `settings.json` credential/config requiring a restart).
- **Tests:** e2e suite gets a locale pin; new unit-ish checks assert that key files contain no hard-coded display text and that all resource files share the same key set.
- **Dependencies:** `i18next`, `react-i18next` (both runtime, tree-shakeable, no native/binary impact — `npmRebuild` and the bundled-Node ABI are unaffected).
