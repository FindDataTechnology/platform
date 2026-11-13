## Why

The platform produces two kinds of durable-looking output that have no durable home. ECharts charts exist only as ` ```echarts ` fences inside `chat_messages.content` — rendered on read, never extracted, so "the chart from yesterday" can only be found by re-reading the conversation it happened to land in. Files written by the agent live as bytes in a *mutable* workspace served one-path-at-a-time by `GET /api/files`: there is no registry, no listing, and a workspace switch or session deletion orphans them. Worse, the miniprogram — the primary mobile surface — cannot see produced files at all: markdown links copy to clipboard, tool blocks fold to a summary, nothing is previewable or saveable. Users who generate a report or a chart on their phone have no way to get it back.

## What Changes

- **New resource store.** A `resources` SQLite table (migration 16) holding typed artifacts — `chart` and `file` in v1, extensible by `type` — with `payload` JSON for self-contained types, an optional stored-bytes reference for files, provenance (`session_id` as a *soft* reference with a title snapshot, `message_id`), and a content hash for dedupe. Byte payloads are copied into `resources-store/files/<id>/<name>`; `/api/files` gains a third root (`root=resources`) so the existing path-hardening, Range/ETag and disposition logic serve them unchanged.
- **Auto-capture of charts.** `chat-history.recordMessage` — the single choke point every assistant turn passes through (web, miniprogram, and cron-fired turns alike) — extracts ` ```echarts ` fences using the renderer's existing parse contract (fence body parses as a JSON object) and records a resource. Content-hash dedupe means regeneration ("honest re-send" — dsh has no replace-turn RPC) and repeated specs never duplicate.
- **Manual save of files.** Files enter the library only by explicit user action, and only then are bytes copied (size cap 20MB, no total quota in v1). Entry points: the web preview drawer and the miniprogram file chip. Uploads are NOT resources — they are already owned by the document library.
- **REST + live consistency.** `GET/POST/PATCH/DELETE /api/resources`, plus a `resources_changed` WS broadcast so an open library reflects captures as they happen.
- **Web surface.** A `/resources` page (sidebar tab Resources, after Knowledge): chart cards render live through the existing `EChart.tsx`, file cards open through the existing `PreviewDrawer`, both support rename, delete, and jumping back to the source session. The chat's file chip and preview drawer gain a "save to resources" action.
- **Miniprogram surface.** A `pages/resources/index` page and a "我的资源" group in the history drawer (mirroring the scheduled-tasks group). Charts re-render through the existing dependency-free canvas renderer. Files become previewable for the first time (`downloadFile` + `openDocument`/`previewImage`) and can be forwarded to a WeChat chat; in-chat, a markdown link that resolves to a workspace file renders as a tappable file chip instead of copying to clipboard.
- **Optional backfill.** A one-shot script that scans existing `chat_messages` for chart fences and seeds the library, so charts already produced in production are not lost.
- **Explicitly not in v1:** resource sharing through the share module, resources as knowledge-base documents, agent/MCP retrieval of the library, server-side auto-discovery of file writes (deliberately deferred — path detection from every tool call is noisy; save stays user-initiated), and any attempt to download files into the phone's filesystem from the mini program.

## Capabilities

### New Capabilities

- `resource-library`: the in-cell store and capture engine — resources table and migration, chart auto-capture from assistant turns, manual file save with byte copying, dedupe and provenance rules, lifecycle independent of sessions, REST API, byte serving through the files route's third root, change broadcast, and the backfill path.
- `resource-library-ui`: the two client surfaces — the web resources page and chat save affordances, the miniprogram resources page, the miniprogram file chip and its preview/forward/save actions, and the live-update behavior of both lists.

### Modified Capabilities

- `app-navigation`: the canonical tab set gains **Resources** (order: Chat, Knowledge, Resources, Agents, Bots, Trace) with route `/resources`.
- `miniprogram-client`: the history secondary-surfaces requirement gains the "我的资源" group (count on the header, one tap deep); the markdown requirement's link handling gains the file-reference branch (a workspace file link renders as an actionable chip, not a clipboard copy).

## Impact

- Server: `db.js` migration 16 + resource accessors; new `resources.js` service; capture hook in `chat-history.js` `recordMessage`; third root + save/preview wiring in `server/routes/files.js`; new `server/routes/resources.js` registered in `server.js`. Backfill script under `scripts/`.
- Clients: `packages/core` gains the resources API client and the shared href→file-reference rule (extracted from `web/src/lib/file-preview.ts` so web and miniprogram agree); `web/src` gains the page, sidebar tab, i18n keys, and chat save action; `miniapp/src` gains the page, drawer group, file chip component, and preview plumbing.
- Data: new `resources-store/` data directory (no collision with the packaging-time root `resources/` directory, which is never imported); per-cell DB rows; nothing migrates for existing deployments except the optional backfill.
- Specs: `app-navigation` and `miniprogram-client` requirements restated with the additions above.
- Tests: e2e for capture/dedupe/REST round-trips and file save; web page smoke; miniprogram chip + page smoke. Mini-program `shareFileMessage` constraints (base library version, size limit) and `downloadFile` size ceiling are verified during implementation against the official docs, and the 20MB cap moves if they demand it.