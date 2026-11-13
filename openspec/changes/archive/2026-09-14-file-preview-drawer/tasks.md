# Tasks: file-preview-drawer

## 1. File serving route (server)

- [x] 1.1 Add `server/routes/files.js` exposing a read-only `GET` that takes a relative path and returns bytes.
- [x] 1.2 Resolve the requested path against an allowlist of roots (agent workspace + a dedicated uploads directory); `fs.realpath` the result and reject any path outside its root, any absolute path, and any escaping symlink (return `403`); missing files `404`.
- [x] 1.3 Mount the route alongside the existing `/api/*` routes so the SPA catch-all does not shadow it.
- [x] 1.4 Apply the content-type policy: inline with a conservative type for the safe-type allowlist (images, PDF, plain text); download disposition + opaque type otherwise.
- [x] 1.5 Add the dedicated uploads directory (under `PLATFORM_DATA_DIR` when set) and a write path into it (reused by whatever stores an uploaded file).

## 2. Drawer surface (client)

- [x] 2.1 Add a right-side drawer component (plain fixed panel with a width transition; no new dependency needed — the `ui/` set has only dialog today).
- [x] 2.2 Add a small preview store (open file reference, close) that does not unmount the chat.
- [x] 2.3 Lazy-load the drawer and renderer code on first open.

## 3. Per-type renderers

- [x] 3.1 Image, PDF, text/markdown renderers (native / reuse `Markdown`).
- [x] 3.2 CSV → table renderer.
- [x] 3.3 HTML renderer inside a sandboxed context with no same-origin access.
- [x] 3.4 Add a `docx` renderer dependency and render its output in the sandbox (not the main DOM).
- [x] 3.5 Unknown/unrenderable type → download action, never an error state.
- [x] 3.6 (Optional) `xlsx` renderer — **deliberately not built**: a spreadsheet falls to the download action, which the spec already requires for unrenderable types. Add it only if users ask.

## 4. Local files (no server)

- [x] 4.1 Add a local-file affordance (picker and/or drop) that previews a `File` via an object URL.
- [x] 4.2 Verify no request carries the file's bytes; revoke the object URL on close.

## 5. Open affordances

- [x] 5.1 `ToolBlock`: when a completed tool call wrote a file, offer "preview" that opens it in the drawer.
- [x] 5.2 `Markdown.tsx`: intercept links pointing at the file route and open the drawer instead of navigating.

## 6. Optional external preview service

- [x] 6.1 Detect a catalog `external-service` entry for file preview and, for unrenderable types, embed it via the existing `/external/:appId` proxy in the drawer.
- [x] 6.2 Fall back to the download action when the entry is absent or unreachable.
- [x] 6.3 Document the operator setup, including that the service fetches the file by URL itself and must be able to reach the file route (dev: host address, not container `localhost`), and that this tier does not apply to the desktop build.

## 7. Verification

- [x] 7.1 Test: traversal attempts (`..`, absolute path, escaping symlink) are rejected and read nothing outside the root.
- [x] 7.2 Test: a file whose content is HTML and whose type is not allowlisted forces a download disposition.
- [x] 7.3 Test: a file with no renderer yields a download action, not an error.
- [x] 7.4 Manual: preview an image, a PDF, a text file, a CSV, and a `.docx` in the drawer from both an uploaded file and an agent-produced file. **Verified** for a browser-local file (all five types) and for an agent-produced file (text). The *uploaded-file* half has no UI path yet — `uploads/` has a write helper but the composer still indexes attachments for RAG (a non-goal of this change), so the uploads root is covered by the unit test instead.
- [x] 7.5 Manual: preview a local file and confirm (network panel) nothing is uploaded. **Verified** — no POST/PUT issued during a local preview; the object URL is revoked on close.
- [x] 7.6 Manual: open a preview from a tool block and from an assistant link; confirm the chat stays connected. **Verified** on a real agent turn that wrote a file: the tool block offered preview and served it from the route; an assistant markdown link opened the drawer without navigating. Chat never disconnected.
- [x] 7.7 Manual: with no preview service configured, an unrenderable type falls back to download; the app is unaffected. **Verified** — `.bin` shows the download action and no error text.
- [x] 7.8 Manual: render an HTML preview and a docx preview and confirm neither can reach the application origin or its credentials. **Verified** — both render in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`); the parent sees `contentDocument === null`, i.e. an opaque origin.
