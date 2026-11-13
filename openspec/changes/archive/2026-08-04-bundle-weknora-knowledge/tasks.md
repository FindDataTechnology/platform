## 1. WeKnora Reverse Proxy + Config

- [x] 1.1 Create `weknora.js` — thin module that reads `WEKNORA_BASE_URL` + `WEKNORA_API_KEY` from env (or `dev-settings.json`), exposes `getRuntimeBase()` and `isEnabled()`. Follow the pattern of `open-connector.js`.
- [x] 1.2 Add `/weknora-web` reverse proxy to `server.js` (like `/oc-web` for OpenConnector and `/litellm-web` for LiteLLM). Reverse-proxy WeKnora's native web UI with API key injection. Exclude `/weknora-web` from the SPA catch-all route. Follow the pattern of `/oc-web`.
- [x] 1.3 Update `server.js` to read `WEKNORA_BASE_URL` and `WEKNORA_API_KEY` from env. When `WEKNORA_BASE_URL` is set, mount `/weknora-web` proxy. When unset, skip WeKnora integration (graceful degradation).

## 2. React UI (Iframe Wrapper + Routing)

- [x] 2.1 Create a new React page `web/src/pages/WeKnora.tsx` that embeds WeKnora's native web UI via an iframe pointing to `/weknora-web`. Follow the pattern of `web/src/pages/OpenConnector.tsx` and `web/src/pages/LiteLLM.tsx`. Handle loading/disabled state.
- [x] 2.2 Update `web/src/App.tsx` to add a `/weknora` route that renders the new `WeKnora.tsx` page. Update the sidebar navigation to include a "Knowledge" link pointing to `/weknora` (replace the old "Documents" link).
- [x] 2.3 Remove the old React Documents page (`web/src/pages/Documents.tsx` or equivalent). Remove the `/documents` route from `web/src/App.tsx`. Remove the "Documents" link from the sidebar.

## 3. Remove Old documents.js

- [x] 3.1 Delete `documents.js`. Remove `/api/documents/*` REST routes from `server.js`. Remove `documents_status` WebSocket events from `server.js`.
- [x] 3.2 Remove `documents.js` dependencies from `package.json`: `pageindex`, `@llamaindex/core`, `@llamaindex/readers`, `pdf-parse`, `pdf-poppler` (if no longer used by other modules). Run `npm install` to update `package-lock.json`.
- [x] 3.3 Remove the chat banner that shows documents added during the session. Remove the drag-and-drop and clipboard-paste document ingestion handlers.

## 4. Environment Configuration + Documentation

- [x] 4.1 Update `.env.example` (or `.env` comments) to add `WEKNORA_BASE_URL` and `WEKNORA_API_KEY`. Document that this is a remote WeKnora instance (deployed separately via Docker).
- [x] 4.2 Update `README.md` to document the WeKnora integration: what it is, how to deploy WeKnora (Docker), how to configure it (`WEKNORA_BASE_URL`, `WEKNORA_API_KEY`), how to use it (Knowledge panel), and the migration path for users with existing `documents-store/` data (re-ingest into WeKnora).
- [x] 4.3 Update `CLAUDE.md` to document the WeKnora integration: architecture (remote WeKnora via reverse proxy), configuration (env vars), and the removal of `documents.js`.
