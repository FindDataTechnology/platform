# Design: preview-attached-files

## Context

The previous change built the preview drawer and a read-only file route over two roots — the agent workspace and `uploads/` — and left `saveUploadFile()` as the write path into `uploads/` with **no production caller** (only `scripts/test-file-serving.mjs`). This change is that caller: it connects the composer's upload to the preview root.

Three existing facts make the change small:

- `POST /api/documents` already holds the file in memory (`upload.single("file")` → `req.file.buffer`), so the original bytes are available at the moment of ingest with no extra read.
- `documents.addDocument()` returns an id **in both outcomes** — `{id, name, status:"ready"}` or `{id, name, status:"error", error}` — so a document-keyed store can be written on either path.
- The preview drawer's open API is `usePreviewStore.open({name, url})`, where `url` is a `/api/files?...` route URL. An attachment only needs to supply that URL.

There is one hard conflict with the existing specs: `chat-attachments` states that attachment ingestion introduces **no new server-side file store**. Storing the original contradicts that clause directly, so the change restates the requirement rather than merely adding to it (the `## MODIFIED` delta).

## Decisions

### Key the stored original by document id, in a per-document directory

The original is written to `uploads/<documentId>/<safeName>`. Two consequences fall out of this one decision:

- **Deletion cascades without a migration.** `DELETE /api/documents/:id` removes `uploads/<id>/` (recursive, idempotent). No mapping table, no schema version, because the document id *is* the key.
- **No ref needs persisting.** The location is a pure function of the document id, so nothing has to be stored to find the file again — the upload response just reports it, and any future surface (e.g. the document library) can derive it.

`saveUploadFile(buffer, filename)` gains a key argument (`saveUploadFile(buffer, filename, key)`); the self-generated uuid it used is replaced by the caller's document id. The existing serving route already resolves subpaths under a root, so `uploads/<id>/<name>` serves with no route change.

### Store after ingest, on both outcomes

`addDocument()` returns an id even when extraction fails, so the route stores the original after the call returns and includes the preview reference in both the success and the `422` responses. This is deliberately *not* gated on success: a file whose text extraction failed is exactly the file a user most wants to open, and the alternative (storing before ingest) would require generating the id outside `addDocument` or changing its id contract for no benefit.

### The route orchestrates; the RAG module stays preview-unaware

The storage call and the response field live in `server/routes/documents.js`, not in `documents.js`. `documents.js` is the RAG module; a preview concern should not leak into it. Keeping the wiring in the route also means the RAG pipeline's behavior — extraction, indexing, `source_text` persistence — is literally untouched.

### The chip carries a reference, not the drawer's business

The composer's `Attachment` chip gains an optional preview reference. On a successful upload the chip stores it; activating the chip calls `usePreviewStore.open({name, url})` with `fileUrl("uploads", rel)`. The drawer, the file route, and the store are all unchanged — this change only adds a producer of the same shape the tool block and link entry points already produce. The reference is purely a client affordance and never enters the prompt; the `@doc:<id>` expansion path is untouched.

## Non-goals

- **Images.** An image has no text-extraction type, so it cannot be ingested, and ingesting is what creates the document id this design keys on. Making images attachable would mean a second, ingest-less attachment mode, and the agent still could not see the image — a separate feature (multimodal ingestion), not this one. The drop path's current treatment of unsupported types is unchanged.
- **Previewing library documents from the Documents page.** The dir-keyed layout makes this a small follow-on (the ref is derivable from the document id), but the library list would need to carry the ref and the page would need the entry point; deferred.
- **Storing originals for non-attachment ingestion** (e.g. URL ingests, which have no file).

## Risks

- **Storage growth.** Every attachment now persists its full original in addition to the extracted text. This is the intended cost of being able to preview it, and `multer`'s existing limit bounds a single upload; there is no per-user quota, consistent with the rest of the app.
- **Orphans if the document row is removed outside `DELETE /api/documents/:id`.** With no mapping table, cleanup relies on that route; any future bulk-delete path must remove the directory too. Noted rather than over-built.
- **The helper's signature change** touches the one test that calls it (`scripts/test-file-serving.mjs`); that test is updated with the new key argument.
