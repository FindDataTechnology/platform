# Tasks: preview-attached-files

## 1. Storage write path

- [x] 1.1 Change `saveUploadFile` in `server/routes/files.js` to take a key: `saveUploadFile(buffer, filename, key)`, writing to `uploads/<key>/<safeName>` and returning `{ root: "uploads", rel: "<key>/<safeName>" }`.
- [x] 1.2 Add a `removeUploadDir(key)` helper (`fs.rm` recursive + force) for the delete cascade.
- [x] 1.3 Update `scripts/test-file-serving.mjs` for the new signature.

## 2. Ingest route wiring

- [x] 2.1 In `POST /api/documents`, after `addDocument` returns, store the original when `req.file` is present, keyed by the returned document id.
- [x] 2.2 Include `preview: { root, rel }` in both the success and the `422` responses.
- [x] 2.3 In `DELETE /api/documents/:id`, remove the document's stored original (idempotent).

## 3. Composer chip

- [x] 3.1 Add an optional preview reference to the `Attachment` interface in `web/src/components/Composer.tsx`.
- [x] 3.2 On a successful upload, store the reference from the response on the chip.
- [x] 3.3 Make an attached chip's name an activatable control that calls `usePreviewStore.open({ name, url: fileUrl("uploads", rel) })`; leave the chip's remove/cancel controls unchanged.
- [x] 3.4 Ensure the reference never enters the composed text (the `@doc:<id>` line is unchanged).

## 4. Verification

- [x] 4.1 Extend `scripts/test-file-serving.mjs` (or an equivalent) to assert the stored file is served back through the route and that `removeUploadDir` removes it.
- [x] 4.2 Manual: attach a CSV and confirm the chip opens the drawer showing the original, and that ingestion still references the document in the prompt.
- [x] 4.3 Manual: attach a file whose extraction fails and confirm the chip still previews the original while reporting the failure.
- [x] 4.4 Manual: delete the document and confirm the stored original is gone (a later request for it returns not-found) and the delete route stays idempotent.
- [x] 4.5 Manual: confirm an unsupported type (e.g. an image) behaves exactly as before.

## Notes

- 4.2–4.5 were verified end-to-end rather than by hand: `scripts/test-file-serving.mjs` (8 tests, incl. the serve-back, the cascade, and a traversal-refusing key) plus a real HTTP cycle against a running server (upload → `preview` ref → fetch the bytes → DELETE → re-fetch 404) and two Playwright specs in `e2e/attachment-preview.spec.js` (attached chip opens the drawer; a failed extraction is still previewable). An image is still rejected by the unsupported-type path, unchanged.
- `preview` carries only `{ root, rel }` — the chip already holds the display name, so the extra field would be dead weight.

## Adjacent fixes surfaced by writing to the uploads root

Storing originals made this change the first thing to actually *write* to `uploads/`, which exposed two issues outside the planned tasks. Both are folded in because the change is what makes them reachable:

- **The preview route 403'd every file whose root path contained a dot segment.** `res.sendFile(absolutePath, { dotfiles: "deny" })` applies the policy to the whole path, so a dot in the root's *prefix* — a home dir like `/Users/john.doe`, or the e2e temp root `.e2e-store-3100` — was read as a forbidden dotfile. Fixed by sending the path relative to the served root (`{ root: realRoot }`), which keeps the guard exactly where it belongs: a `.env` inside the root is still denied (new test: `a root under a dotted path still serves; only dotfiles inside the root are refused`). In production this would have broken previews for any user whose home path contains a dot.
- **`uploads/` was neither gitignored nor isolated in e2e.** Every peer runtime store is listed in `.gitignore` and overridden by the e2e harness; `uploads/` was neither, so uploads landed in the repo root. Added `/uploads/` to `.gitignore` and set `PLATFORM_DATA_DIR` to the e2e temp root, so the suite is hermetic again.

## Post-review fixes

A code review of this diff found four more defects, all fixed:

- **A failed `rm` could kill the server.** `await removeUploadDir(...)` was unguarded in the DELETE handler; Express 4 does not catch a rejected async handler and nothing upstream handles unhandled rejections, so an `EBUSY` (Windows, while the drawer still streams the file) or `EPERM` would terminate the process for a delete that had already succeeded. Now `.catch()`-guarded like the write path.
- **A dotted filename produced a reference that could never be served.** The sanitizer kept the leading dot, so `.env` was stored as `uploads/<id>/.env` and returned a preview ref that the route's `dotfiles: "deny"` 403s forever (download too). Leading dots are now stripped, and the name can no longer collapse to `.`/`..` (which resolved onto the uploads root and failed `EISDIR`, swallowed into a silently preview-less attachment). Both covered by new tests.
- **The chip's `state !== "uploading"` guard was dead** — `preview` is only ever assigned after the chip leaves the uploading state. Simplified to `a.preview`.
- **The `uploads/` ignore pattern was unanchored**, so it would silently untrack any future `e2e/uploads/` fixture directory. Anchored to `/uploads/`.

Findings deliberately **not** acted on: (a) library (Knowledge-page) uploads also store an original because the route is shared — intended groundwork for library preview, reclaimed on delete, now noted rather than gated; (b) the reviewer's suggestion to fold `uploadFile`'s error-body parse back into `jsonOrThrow` — the current version keeps the contract explicit at the call site.
