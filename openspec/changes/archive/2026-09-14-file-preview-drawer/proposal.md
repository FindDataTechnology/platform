# Proposal: file-preview-drawer

## Why

The application can ingest documents but cannot *show* them. Attaching a file (`chat-attachments`, `drag-drop-upload`) sends it to the RAG pipeline at `POST /api/documents`, which extracts text and **discards the original bytes** (`documents.js` stores only `source_text`), and the drop path outright rejects images with `415`. There is no route that serves a file to the browser and no surface that displays one. As a result a user cannot look at a document they just attached, a document the agent produced in its workspace, or a local file they simply want to inspect next to the chat — they download it and leave, or they never upload it at all.

## What Changes

- Add a right-side **preview drawer** that displays a single file, opened from wherever a file is referenced.
- Add one **read-only, path-traversal-safe file-serving route** over an allowlisted root, serving bytes the browser can fetch by reference.
- Add **client-side renderers** for the common types — images, PDF, plain text/markdown, CSV, HTML — reusing native browser capabilities, and `docx` via a small dependency. Unknown or unrenderable types offer a download instead.
- Support **local (un-uploaded) files entirely in the browser**: the file never leaves the machine, and the server is not involved.
- Optionally delegate long-tail formats (legacy Office, audio/video, archives, CAD) to an **external preview service** declared as a catalog `external-service`; when none is configured the drawer degrades to download. This follows the project's existing external-service + graceful-degradation conventions.

## Capabilities

### New Capabilities

- `file-preview`: the serving route and its safety invariants, the preview drawer surface, per-type rendering with download fallback, the browser-local file path, and the optional external-service delegation.

### Modified Capabilities

_None._ The composer attachment flow (`chat-attachments`, `drag-drop-upload`) is intentionally left unchanged; unifying "attach for the agent" with "preview" is a separate decision (see Non-goals).

## Impact

- **Code:** new `server/routes/files.js` (serving route, mounted alongside the existing `/api/*` routes); new frontend preview components and a drawer primitive; a `Markdown.tsx` link-intercept for in-chat file references; a "preview" affordance on the tool block that produced a file.
- **APIs:** add a read-only file-fetch endpoint. No change to existing endpoints.
- **Dependencies:** add a `docx` renderer to `web/`; possibly `xlsx` if spreadsheet preview is in scope.
- **Configuration:** an optional preview-service URL (catalog `external-service` entry); absent means download fallback.
- **Data:** the route serves from a configured root; it introduces no new persistent store of its own beyond where uploaded/produced files already live.

## Non-goals

- Not unifying the composer's attach-to-RAG flow with preview in this change. Today "attach" means "index for the agent"; making the same gesture also mean "store and display" is a deliberate follow-up, and the drawer can be built and used without it.
- Not previewing legacy binary `.doc` or client-side `.pptx`; these fall to the external service or download.
- Not adding attachment upload for the agent; the existing `/api/documents` path is unchanged.
