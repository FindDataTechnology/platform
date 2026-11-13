# Proposal: preview-attached-files

## Why

Attaching a file in the composer does one thing: it indexes the file for the agent (`POST /api/documents` → RAG), and the ingestion **discards the original bytes**. The preview drawer can display a file the agent produced or a local file, but not the file the user just attached — the one file the user is most likely to want to look at. The previous change left the write path into the preview `uploads/` root deliberately unused for exactly this follow-up.

## What Changes

- **BREAKING (spec-level):** the `chat-attachments` requirement that says attachment ingestion introduces *no new server-side file store* is superseded. Attachment ingestion now also persists the file's original bytes in the preview `uploads/` root.
- The upload response carries a preview reference; the composer's attachment chip becomes clickable and opens the file in the existing preview drawer.
- The stored original is removed when its document is removed, so deletion does not orphan bytes on disk.
- Nothing else about attachment behavior changes: ingestion, the `@doc:<id>` prompt reference, and the upload/insert/abort lifecycle are untouched.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-attachments`: the composer attachment affordance now persists the original file (replacing the "no new server-side file store" constraint) and exposes it as previewable; the stored original is deleted with its document.
- `file-preview`: adds the attachment chip as an entry point into the drawer, alongside tool blocks and assistant links.

## Impact

- **Code:** `server/routes/files.js` (the upload write path gains a document-keyed location), `server/routes/documents.js` (`POST` stores the original and returns the reference; `DELETE` removes it), `web/src/components/Composer.tsx` (the chip carries and opens the reference).
- **Data:** files land under the preview `uploads/` root keyed by document id, so deletion cascades without a schema migration.
- **No** change to the RAG pipeline internals, the prompt-expansion path, or the WebSocket protocol.
