## Context

See `proposal.md` — Why. Facts that shape the approach, verified in the repo:

- `chat-history.recordMessage(sessionId, role, content, blocks)` is the single funnel every turn passes through: web WS (`server/ws.js`), the agent-session path (`server/agent-session.js`), dsh events (`server/dsh-events.js`), and cron-driven turns (`server/cron-runner.js`). It already no-ops when the DB is unavailable and while a session is being deleted.
- The DB is per-cell SQLite with numbered migrations (`db.js`), currently at version 15. `db.appendMessage` inserts a row and returns the per-session `seq` (no caller uses the return value).
- `paths.js#storeDir(subdir, override)` resolves a store dir: module-specific env override → `PLATFORM_DATA_DIR/<subdir>` (packaged/cell) → CWD-relative (dev). `cron-store/`, `documents-store/` follow this.
- `server/routes/files.js` serves bytes by `(root, path)` against an allowlist of roots (`workspace`, `uploads`) with lexical + realpath containment, symlink-escape rejection, inline/download disposition by extension, and `sendFile`-provided Range/ETag/HEAD. `scripts/test-file-serving.mjs` covers it.
- `documents.js` + `server/routes/documents.js` are the in-repo template for "SQLite rows + a service module + a registered route + `ctx.broadcast` consistency events".
- Clients share REST transport through `packages/core/src/api/*`; the server imports nothing from `packages/core` (no precedent, and it is client TS).
- Web already owns the chart renderer (`web/src/components/EChart.tsx`, sanitizing `tooltip.formatter`), the file-reference detection rules (`web/src/lib/file-preview.ts`: `PATH_KEYS`, preview extension set, `linkRef`), and the preview drawer. The mini program owns a dependency-free canvas chart renderer (`miniapp/src/lib/charts.ts`) and a markdown tokenizer that already emits `link` tokens — whose tap currently copies to clipboard because a mini program cannot open arbitrary URLs.
- Verification surfaces: `npm run test:unit` (`node --test scripts/test-*.mjs`, boots real cells against temp dirs), Playwright projects fast/smoke/live (`e2e/*.spec.js`), locale key-parity enforced by `scripts/check-locales.js` across `en, zh-CN, es, fr, ja`. Mini-program behavior is verified through the WeChat devtools automation flow and shipped by a separate version upload + review — a different clock from the cell.

## Goals / Non-Goals

**Goals:**

- A typed, extensible resource store that is durable and session-independent.
- Charts captured with zero user action; files captured only by explicit save — with the expensive part (bytes) always user-triggered.
- Both clients can browse, preview, rename, delete, and jump back to the source.
- Reuse of the existing serving hardening, renderers, and REST/auth plumbing — no new auth, no new transport.
- A capture contract that cannot silently drift from the rendering contract.

**Non-Goals:**

- No byte-level versioning or tombstones: a resource's identity is its content; deleting removes it for good and nothing resurrects it automatically.
- No file auto-discovery from tool calls (rejected: every read/write path would register, and the library would fill with scratch files; v1 discovery is user action).
- No agent/MCP access to the library, no share-module integration, no knowledge-base ingestion (deferred; see proposal).
- No exact message scroll restoration on jump-to-source: v1 opens the session; the message reference is stored for later.
- No attempt to write files into the phone's filesystem from the mini program.

## Decisions

### Capture point: inside `recordMessage`, after the insert

Chart capture runs in `chat-history.recordMessage` for `role === "assistant"`, immediately after the message row is inserted, using the inserted row id as the message reference. Alternatives: hooking each of the four call sites (drift risk, four places to keep in sync) or a periodic history scanner (latency, and it would re-scan history forever). The funnel is already the invariant "every turn is mirrored here", so attaching to it means cron turns, web turns, and mini-program turns are covered by construction. Malformed fences are not captured — the same fallback rule the renderers use.

`db.appendMessage` gains a return of `{ seq, id }` (or equivalent) so the resource can record the row id; no existing caller reads the return, so this is behavior-neutral.

### Two parsers, one contract — guarded by shared fixtures

The server gets its own small extractor (`extractChartSpecs(text)` in `resources.js`). It is deliberately *not* shared with the clients: the server imports nothing from `packages/core` today, and introducing that edge for ~40 lines of parsing is worse than the duplication. The contract is held by fixtures: a unit test (`scripts/test-resources-capture.mjs`) asserts the extraction rules (valid fence, multiple fences, malformed body, partial fence, non-chart languages, JSON that parses to an array or scalar) against the same corpus the client parsers are expected to satisfy; the existing `e2e/chat-chart-rendering.spec.js` continues to guard the rendering side.

### Storage: rows in the cell DB, bytes under a new store dir, served by a third root

One table, migration 16:

```
resources(
  id TEXT PRIMARY KEY,             -- uuid
  type TEXT NOT NULL,              -- 'chart' | 'file' | future
  title TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'auto' | 'manual'
  session_id TEXT,                 -- soft ref, no FK
  session_title TEXT,              -- snapshot at capture
  message_id INTEGER,              -- soft ref (chat_messages row id)
  payload TEXT,                    -- chart: normalized option JSON
  file_path TEXT,                  -- file: path relative to the resources root
  file_size INTEGER, file_mime TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT,
  seeded INTEGER NOT NULL DEFAULT 0
)
+ UNIQUE INDEX on content_hash, INDEX on (type, created_at)
```

- **Bytes on disk, not BLOBs**: `resources-store/files/<id>/<name>` — keeps the DB small, and makes the existing file route's Range/ETag work for free. Alternatives: BLOB (WAL growth, no streaming), reference-to-workspace (fragile by design).
- **Third root**: `rootsFor(ctx)` gains `resources → <storeDir("resources-store")>/files`; the web `Root` type and `linkRef`'s root allowlist gain `resources`. A dedicated `/api/resources/:id/raw` endpoint was rejected: it would re-implement containment and lose `sendFile`'s Range/ETag.
- **Naming**: `resources.js`, `resources-store/`, `/api/resources`. The repo root's `resources/` directory (packaged Node runtime) is never imported as a module; the two coexist, and the service module carries a comment noting the distinction.

### Identity is content, provenance is first-sighting

Chart hash: sha256 of the normalized option JSON (`JSON.stringify` of the parsed object) — byte-identical specs hash identically, which is exactly the regeneration case. File hash: sha256 of the copied bytes. On a repeat hash, the existing row's `last_seen_at` is refreshed and its provenance is kept. Consequences, accepted deliberately: regeneration never duplicates; the same spec seen in two sessions is one entry; saving two byte-identical files under different names is one entry (the second save reports "already in the library"); a re-save after deleting the earlier entry creates a fresh row (no tombstones).

Title derivation: chart → `option.title.text` when it is a string, else `<session title> · 图表 N`; file → basename. Renaming sets the title explicitly; it never forks the identity.

### Seed path: marker-guarded, prefiltered, and reproducible by script

A `user_preferences` marker (`resources.seeded_at`) gates a one-time startup pass over `chat_messages` assistant rows prefiltered by `content LIKE '%```echarts%'`, inserting in one transaction. `scripts/seed-resources.mjs` exposes the same routine for explicit operator re-runs (documented: a re-run can resurrect user-deleted charts; the automatic pass cannot, because the marker exists). Alternative: a `migrate.js` step — rejected, that file exists for legacy on-disk store imports.

### Consistency: broad-cast, clients refetch

`ctx.broadcast("resources_changed", { action, id, type })` on capture/save/rename/delete — the `documents_status` pattern. Clients refetch their current query rather than patching incrementally; lists are small and this removes all merge logic.

### Clients

- **Web**: `/resources` route + sidebar tab; page state via a small zustand store fed by the REST client and the WS event; chart cards reuse `EChart.tsx` (the sanitizer applies unchanged); file cards open `PreviewDrawer` with `{ root: "resources" }`; the drawer gains the save-to-resources action (the single place that covers every file entry point). i18n keys go into all five locale bundles (`en` is the source of truth; `check:locales` enforces parity).
- **Mini program**: new `pages/resources/index` registered in `app.config.ts`, entered from the history surface's new resources group (mirroring the scheduled-tasks group's look and fetch-on-open behavior). The href→file-reference rule (extension sets, absolute-under-workspace vs relative resolution) is extracted into `packages/core/src/lib/file-ref.ts` and consumed by both web's `file-preview.ts` (which keeps its URL builder) and the new mini-program file chip, so the two clients cannot disagree about what "is a file" means. The chip needs the session's workspace (already returned by the chat-history API's session metadata).
- **Mini-program file transfer**: `Taro.downloadFile` with the same bearer header and silent-relogin-once behavior as `taro-http.ts`, then `openDocument` (office/PDF) or the image viewer; `shareFileMessage` is feature-detected and the forward action is hidden when the base library does not support it (exact version/size constraints verified during implementation — if the platform caps below 20MB, the cap constant moves, not the design).
- **Version skew**: the mini program and the cell deploy on different clocks. The resources group and page hide themselves when the cell answers `404` (older cell), and the cell ignores a missing client gracefully. Ship cell first, client second.

### Verification

- `scripts/test-resources-capture.mjs` (extraction contract, dedupe, seed marker), `scripts/test-resources-store.mjs` (save: copy + hash + oversize + missing + traversal; delete removes bytes; rename; list filters), extending `scripts/test-file-serving.mjs` for the third root and `scripts/test-cell-containment.mjs` with the save path (the store must honor `storeDir`; the audit proves no CWD-relative writes).
- Playwright (fast): a resources page spec reusing the chart-rendering harness to produce a captured chart, then asserting list/filter/rename/delete/jump; a save-from-drawer spec that plants a workspace file through the existing e2e seam.
- Mini program: devtools automation for the chip states, the page listing both types, preview, and the drawer group; plus the standard client version upload and console resubmission handoff.

## Risks / Trade-offs

- [Library noise: every chart ever produced becomes an entry] → acceptable — charts are small, content-deduped, deletable, and the page has a type filter and search. If it becomes a flood, a v2 "archive/hide" action is additive.
- [Content-hash dedupe surprises a user who wants a second copy] → accepted deliberately; identity is content, and the save path says "already in the library" rather than silently creating a near-duplicate.
- [Mini program cannot reach every file: only linked files get chips, and preview depends on platform limits] → the spec requires a clear message and the forward path instead of broken previews; discovery beyond links is explicitly deferred.
- [Seeding cost on a large history] → `LIKE` prefilter plus a single transaction, and it runs once; if a cell is enormous, the script path allows manual control.
- [Third root widens the served surface] → the root only ever contains server-copied bytes; the path itself is derived from the resource id; containment tests extend to it.
- [Charts deleted by the user can reappear] → only via the explicit script re-run (documented); the automatic path is marker-guarded. A regenerated answer producing the same chart *is* a new record event and will re-create it — correct behavior, worth stating in the UI docs.
- [Mobile preview/forward constraints are verified late] → they are isolated in one adapter (`downloadFile` → `openDocument`/`shareFileMessage`); the size cap and the feature-detection branch are the only knobs.

## Migration Plan

1. Ship the cell: migration 16 is additive and idempotent; seeding runs once, marker-guarded; the resources store dir is created lazily on first save. Old code on rollback ignores the table and the bytes directory (removable manually) — no downgrade hazard.
2. Then ship the web build (same pipeline as always) — the sidebar tab and page light up immediately.
3. Ship the mini program last: version bump, devtools verification, upload, and the console resubmission handoff. The client degrades against a cell older than step 1 by hiding the group on `404`.
4. No data migration for existing deployments beyond the optional seeding pass.

## Open Questions

- Mini-program `downloadFile`/`openDocument`/`shareFileMessage` exact limits and base-library gates — verified during implementation; affects the size cap constant and the forward action's visibility only.
- Whether the mini program should also surface tool-block file paths as chips (a discovery path beyond markdown links) — deferred to a follow-up; does not change the store or API.
- Whether `file_mime` earns its column (UI filtering uses the extension today) — trivially droppable at implementation if unused.