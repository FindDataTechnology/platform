## 1. Store and migration (engine foundation)

- [x] 1.1 Add migration 16 to `db.js`: `resources` table (`id, type, title, source, session_id, session_title, message_id, payload, file_path, file_size, file_mime, content_hash, created_at, updated_at, last_seen_at, seeded`), unique index on `content_hash`, index on `(type, created_at)`. Verify: `node scripts/test-resources-store.mjs` (new, temp `DB_PATH`) asserts the table, both indexes, and idempotent re-open.
- [x] 1.2 Add `db.js` accessors: insert, get, list (type filter + title search + pagination + total), rename, delete, find-by-hash, touch-last-seen. Verify: the accessor section of `scripts/test-resources-store.mjs` covers each including the hash lookup returning the existing row.
- [x] 1.3 Change `db.appendMessage` to return the inserted row id (today it returns `seq`; no caller reads it). Verify: `npm run test:unit` stays green (existing chat-history suites exercise every call path).
- [x] 1.4 Create `resources.js` service: `initStore` (store dir via `storeDir("resources-store", RESOURCES_STORAGE_PATH)`, lazily created), `RESOURCE_MAX_FILE_BYTES` (default 20MB, env-overridable), `extractChartSpecs(text)`, `captureFromMessage`, `saveFile`, `list/get/rename/remove`, `seedFromHistory`. Verify: `scripts/test-resources-capture.mjs` (new) covers the extraction contract — valid fence, several fences in one message, malformed body, array/scalar JSON, unterminated fence, other languages — and title derivation.

## 2. Capture wiring

- [x] 2.1 Hook `captureFromMessage` into `chat-history.recordMessage` for assistant turns, after the message insert, passing the new row id and the session title snapshot; keep the existing DB-unavailable and deleting-session guards. Verify: `scripts/test-resources-capture.mjs` asserts an assistant turn with a chart fence produces exactly one `chart` row with provenance (session id, title snapshot, message id), and a repeat of the same spec refreshes `last_seen_at` without a second row.
- [x] 2.2 Confirm scheduled-task turns are captured by the same funnel (cron drives `recordMessage`). Verify: `scripts/test-cron-*`-style unit run, or extend `scripts/test-resources-capture.mjs` with the cron-runner call shape, asserting a chart from a job's turn lands in the library.

## 3. File save path

- [x] 3.1 Implement `saveFile`: resolve the source against the workspace root with the same hardening as the serving route (reject absolute paths, `..`, NUL, symlink escapes; require an existing regular file inside the workspace; refuse `uploads`/documents), enforce the size cap, copy to `resources-store/files/<id>/<name>` (temp file + rename), hash the bytes, dedupe by hash, return "already stored" for a repeat. Verify: `scripts/test-resources-store.mjs` covers success, oversize, missing source, traversal/absolute/symlink attempts, repeat-save dedupe, and that a failed save leaves no partial bytes.
- [x] 3.2 Implement delete (row + bytes) and rename (title only, identity unchanged). Verify: same script — after delete the bytes directory is gone; after rename the hash lookup still finds one row.

## 4. Serving route and REST

- [x] 4.1 Add the third root to `server/routes/files.js` (`resources` → `<storeDir("resources-store")>/files`) leaving the route strictly read-only. Verify: extend `scripts/test-file-serving.mjs` (serve a planted stored file; traversal/absolute/symlink attempts against the new root rejected; disposition by extension unchanged) and run it.
- [x] 4.2 Extend `scripts/test-cell-containment.mjs` with a resource save in an empty-CWD cell and assert the CWD stays clean (the store must honor `storeDir`). Verify: the script passes.
- [x] 4.3 Create `server/routes/resources.js` (list with `type`/`q`/pagination, save, rename, delete) and register it in `server.js` with `resources.initStore({ broadcast })` in the app context init. Broadcast `resources_changed { action, id, type }` on every mutation. Verify: a unit/e2e round-trip (temp cell + identity headers) for list/save/rename/delete, a 401 without credentials, and one broadcast received on the WS for a capture.

## 5. Seed path

- [x] 5.1 Implement `seedFromHistory` (assistant rows prefiltered by `content LIKE '%```echarts%'`, one transaction, `user_preferences` marker `resources.seeded_at`) and wire it to run once at store init. Verify: `scripts/test-resources-capture.mjs` — a DB pre-populated with chart-bearing and chart-free messages seeds exactly the charts; a second init run inserts nothing; a resource deleted between the two runs is not resurrected.
- [x] 5.2 Add `scripts/seed-resources.mjs` for explicit operator re-runs (path argument, dry-run count). Verify: run it against a temp DB twice — first seeds, second reports existing/deduplicated counts without duplicating.

## 6. Shared client plumbing

- [x] 6.1 Extract the href→file-reference rule into `packages/core/src/lib/file-ref.ts` (preview extension sets, `kindOf`/`extOf`/basename, absolute-under-workspace vs relative resolution) and rewire `web/src/lib/file-preview.ts` to consume it, extending `Root` and `linkRef`'s allowlist with `resources`. Verify: `npm --prefix web run typecheck` and the existing file-preview and attachment e2e specs stay green.
- [x] 6.2 Add `packages/core/src/api/resources-api.ts` (list/save/rename/delete + types) on the shared transport. Verify: consumed by both clients in the tasks below; web typecheck passes at this step.

## 7. Web surface

- [x] 7.1 Add the `/resources` route, the sidebar Resources tab (order Chat, Knowledge, Resources, Agents, Bots, Trace), and i18n keys in all five locale bundles. Verify: `npm run check:locales` passes and `e2e/nav-routes.spec.js` / i18n spec are extended and green.
- [x] 7.2 Build the resources page: list with type filter and title search, live chart cards via the existing chart component, file cards opening the preview drawer with `root=resources`, rename, delete with confirmation, jump-to-source (absent/disabled when the session is gone), and the empty state. Verify: new `e2e/resources-page.spec.js` — capture a chart through the existing chart-rendering harness, then assert list, filter, rename, delete, jump, and empty state.
- [x] 7.3 Add save-to-resources to the preview drawer for workspace files, with "already in the library" and failure (too large / missing) messages. Verify: new `e2e/resources-save.spec.js` plants a workspace file, saves it from the drawer, and asserts the resource appears on the page and a second save reports already-stored.
- [x] 7.4 Live updates: the page and any open list refetch on `resources_changed`. Verify: in the fast suite, a capture performed while the page is open appears without reload.

## 8. Mini program surface

- [x] 8.1 Add `pages/resources/index` to `app.config.ts` and the resources group to the history surface (count on the header, one tap deep, hidden when the cell answers 404 — older cell). Charts render through the existing canvas renderer; stored files preview through the transfer adapter (8.3); rename, delete, and jump-to-source per spec. Verify: devtools automation walkthrough — group count, page lists both types, chart renders, rename/delete round-trip, jump back to the session.
- [x] 8.2 Make workspace-file links in completed assistant messages render as a file chip (detection via the shared `file-ref` rule and the session's workspace), with an action sheet offering 预览 and 存入资源, a saved state after saving, and unchanged clipboard behavior for every other link. Verify: devtools automation — a scripted assistant message with a file link shows a chip, the action sheet works, the saved state appears; an external URL keeps the copy-to-clipboard toast.
- [x] 8.3 Implement the mini-program file transfer adapter (`taro-http`-style bearer + silent re-login once, `Taro.downloadFile`, `openDocument` for office/PDF, image viewer for images) and `shareFileMessage` with feature detection, hiding the forward action when unsupported. Verify: devtools walkthrough of a stored document (native viewer opens) and an unpreviewable type (forward offered; platform-unsupported case hides it); record the verified platform limits in the change notes.
- [x] 8.4 Mini-program version upload and resubmission handoff (version bump, description, self-test path, review note), following the established `wechatide` flow. Verify: the upload completes and the user is handed the submission checklist.

## 9. Verification, docs, release

- [x] 9.1 Full local suites: `npm run test:unit`, `npm run test:e2e`, `npm run lint`, `npm --prefix web run typecheck`, `npm --prefix miniapp run typecheck`. Verify: all green against the recorded flake baseline; any new failure explained, not just retried.
- [x] 9.2 Live probe on a real cell: a real turn produces a chart that lands in the library unattended; save a genuinely generated file and preview it in both clients; confirm the seed pass on a cell with existing history. Verify: probe transcript recorded in the change notes. — fd-prod: capture + seeding + store/serve proven (transcript in notes); a *genuinely generated* file could not be saved on that cell because its agent workspace `/app` is root-owned and unwritable, so the agent writes to `/tmp` (outside the workspace root, refused by design) — see the finding in notes.md; the save/preview path itself is covered locally by `e2e/resources-save.spec.js` and the mini-program walkthrough.
- [x] 9.3 Update `README.md` module lists (both language sections) with `resources.js` and the env table with `RESOURCES_STORAGE_PATH` / `RESOURCE_MAX_FILE_BYTES`. Verify: `grep` finds both entries; `npm run test:unit` still green (no script depends on the README text).
- [x] 9.4 Release handoff: cell + web through the standard pipeline (Jenkins → Harbor → GitOps tag bump → ArgoCD), mini program after (per 8.4), with the cell-first ordering documented for rollback safety. Verify: deployed cell answers `/api/resources` and the ops board shows the new revision healthy. — Jenkins #31 → `sha-ea802e5` → GitOps `14c3255` → ArgoCD Synced/Healthy; `/api/resources` 200 on the live cell; board inputs all in agreement (`in sync at sha-ea802e5`); the board itself is Logto-gated, so it was verified through its three inputs plus `/healthz` 200.