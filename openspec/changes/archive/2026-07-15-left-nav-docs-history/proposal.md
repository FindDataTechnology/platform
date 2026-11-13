## Why

The app's surface is growing - chat, knowledge, OpenConnector, and soon documents and history - but navigation is a row of header toggle buttons that doesn't scale, and two requested capabilities have no home: managing OpenConnector through its own official web UI (the current panel only handles API-key connections), and a LlamaIndex-backed document store to replace the experimental PageIndex `knowledge.js`. Users also have no way to revisit past conversations. This change consolidates everything under a left sidebar nav and adds the missing capabilities.

## What Changes

- **Restructure navigation into a left sidebar.** Replace the header toggle buttons (Chat / Knowledge / OpenConnector) with a persistent left nav listing tabs: Chat, Chat History, Documents, OpenConnector. The active tab owns the main content area. **BREAKING** for the header-toggle UI: the `knowledge-toggle` / `openconnector-toggle` buttons and their `showView()` toggle semantics are removed.
- **Embed OpenConnector's native web UI via a server-side reverse proxy.** Mount a proxy that forwards the runtime's web UI and its asset/API calls through Platform's Express server, injecting the server-held admin token so the browser never sees it. Surfaced as the OpenConnector tab (alongside the existing action-browse/execute panel). This lets users manage connectors - including OAuth - through OpenConnector's official UI without tokens reaching the browser.
- **Add LlamaIndex.TS document management, replacing PageIndex.** Introduce `documents.js` using LlamaIndex.TS for ingestion (PDF/Markdown/text/URL), indexing, persistence, listing, viewing, and retrieval. Remove `knowledge.js` and its `/api/knowledge/*` routes. The Knowledge panel becomes the "Documents" tab with upload, list, view-content, status, and delete. **BREAKING**: `/api/knowledge/*` endpoints and the `knowledge_status` event are removed; replaced by `/api/documents/*` and a `documents_status` event.
- **Add chat history (persist + view only).** Persist each conversation turn to disk as session JSON files. Add a Chat History tab that lists past sessions and lets the user open one to view its messages read-only. No resume into the live agent in this change.
- **Graceful degradation preserved.** OpenConnector web and Documents degrade gracefully when their runtimes/index are unavailable, matching existing conventions.

## Capabilities

### New Capabilities
- `app-navigation`: the left sidebar navigation shell - tab list, active-tab content switching, and the canonical set of tabs (Chat, Chat History, Documents, OpenConnector).
- `open-connector-web`: embedding OpenConnector's native web UI through a token-injecting server-side reverse proxy, exposed as a nav tab.
- `document-management`: LlamaIndex.TS document ingestion, indexing, persistence, listing, content viewing, deletion, and retrieval - replacing PageIndex `knowledge.js`.
- `chat-history`: persistence of chat sessions to disk and a read-only list/view UI.

### Modified Capabilities
- `open-connector-ui`: the panel's toggle mechanism changes from a header button to a left-nav tab governed by `app-navigation`; the panel's browse/search/inspect/execute/API-key-connection behavior is unchanged. The OpenConnector tab now also hosts the embedded native web UI.

## Impact

- **Code**: `server.js` (mount `/api/documents/*`, `/api/chat-history/*`, and the OpenConnector web proxy; remove `/api/knowledge/*`; rewire startup), new `documents.js` (LlamaIndex.TS) replacing `knowledge.js`, new `chat-history.js`, new `open-connector-web.js` (reverse-proxy helper) or extension of `open-connector.js`, `public/index.html` + `public/app.js` + `public/style.css` (sidebar nav, Documents tab, Chat History tab, embedded OpenConnector web frame). `mcp-bridge.js` is unaffected.
- **APIs**: removes `/api/knowledge/*` and the `knowledge_status` WS event; adds `/api/documents/*`, `/api/chat-history/*`, and an OpenConnector web proxy mount path. Adds `documents_status` WS event.
- **Dependencies**: adds `llama-index` (LlamaIndex.TS) and its document-reader packages to `package.json`. PageIndex dependency is removed.
- **Persistence**: new `documents-store/` (replaces `knowledge-store/`) and `chat-history-store/` directories; migration is best-effort (existing `knowledge-store/` indices are not LlamaIndex-compatible and are archived, not converted).
- **Security**: the OpenConnector web proxy must forward only to the configured runtime, inject only the server-held token, and never forward client-supplied `Authorization` - mirroring the existing `open-connector.js` proxy rules.
