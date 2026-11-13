# Design: file-preview-drawer

## Context

Three facts about the current system shape this design:

1. **Attaching a file today means "index it for the agent", not "keep it".** `chat-attachments` and `drag-drop-upload` both POST to `/api/documents`, where `documents.js` runs `extractSourceText` and persists only `source_text` — the original bytes are discarded once indexed. The drop path also rejects non-document types (images) with `415`. So there is no stored artifact to preview; preview needs its own source of bytes.
2. **The agent has a workspace (its `cwd`)** which the app already tracks (`list_workspaces` / `set_workspace`, `currentWorkspace`). Files the agent writes land there on disk; nothing serves them.
3. **A same-origin embed mechanism already exists.** `catalog.js` external services plus `server/routes/external-services.js` (`/external/:appId`) proxy a self-hosted web UI same-origin with server-side credential injection. This is the project's sanctioned way to embed a service it does not bundle.

The constraining requirement is safety: this feature introduces the first route that returns arbitrary file bytes to the browser, and the first place model- or user-authored content is rendered as active content.

## Sources of a file, and where each lives

```
SOURCE               BYTES LIVE            TRANSPORT                SERVER INVOLVED
─────────────────────────────────────────────────────────────────────────────────
local file (no upload) user's machine     File API / object URL    no
uploaded file          server root         POST multipart → disk    yes
agent-produced file    agent workspace     GET file route           yes
```

The **local path is deliberately server-free**: a `File` from the input has no server URL, and sending it would require an upload the user did not ask for. It is previewed from a browser-local object reference. This also means an external preview service (which fetches files by URL) can never serve the local path — the local path is client-renderers only.

## Decisions

### One serving route, an allowlist of roots

A single read-only route serves files by relative path. The allowed roots are the agent workspace (for produced files) and a dedicated uploads directory (for uploaded files). Resolution: join the requested relative path onto a root, `fs.realpath`, then assert the real path is within that root; reject anything else. Reject absolute paths outright. `..` segments, encoded traversal, and escaping symlinks all fall out of the realpath-plus-prefix-check.

Rejected alternative: serving straight from the agent workspace for everything. Uploads would then land in a directory the agent can write — i.e. the agent could overwrite or delete a user's upload, and the route would be exposing an agent-writable tree for a read-only user-facing purpose. Keeping uploads in a separate root costs one extra allowlist entry and removes that coupling.

### Conservative content type, download by default

The route consults a small allowlist of types safe to serve inline (images, PDF, plain text). Anything else is served with a download disposition and an opaque content type. This is the general fix for the specific hazard that serving an uploaded `.html` as `text/html` from the application origin is stored XSS against the app itself. It also matches the project's posture of closing XSS surfaces rather than relying on sanitization (cf. `rehype-raw` being off).

### Active content renders in a sandbox

When the drawer renders HTML, or the `docx` renderer produces markup, it renders inside a sandboxed context without same-origin access, so previewed content cannot reach the application origin, storage, or the WebSocket credential. Consistency here matters more than per-type cleverness: one sandbox policy for anything active.

### Per-type renderers, native first

| Type | Renderer | Cost |
|---|---|---|
| png/jpg/gif/webp/svg | `<img>` | native |
| pdf | `<iframe>`/`<embed>` | native |
| txt/md/code | existing `Markdown` / `<pre>` | free |
| csv | split + table | small |
| html | sandboxed `<iframe>` | native |
| docx | client `docx` renderer | one dependency |
| xlsx | spreadsheet renderer (if in scope) | one dependency |
| `.doc`, pptx, media, archives, CAD | external service or download | — |

Native facilities cover the majority; only the Office formats need dependencies, so the added dependency surface is small and bounded.

### Local files: browser-only

An input/drop target hands the drawer a `File`; the drawer renders it from an object URL. No request carries the bytes. This path has no traversal, no content-type, and no service concerns — it is the simplest path and needs no backend at all.

### Long-tail formats: optional external service, by deployment

When an operator configures a preview service (e.g. KKFileView) as a catalog `external-service`, the drawer embeds it for types the client cannot render, reusing `/external/:appId`. Three properties are load-bearing and are recorded here because they are the non-obvious part:

- **The service fetches the file itself.** KKFileView is given a URL (`?url=<encoded>`) and downloads the file server-side. The file route must therefore be reachable *from the service*, not just from the browser. In local development with the service in Docker, `localhost` inside the container is the container, not the host — the app URL has to be the host address (`host.docker.internal` or the LAN IP). This is the same class of mistake as the project's existing LAN-proxy gotcha.
- **It is a server-side service, so it fits the web deployment and not the desktop app.** The Electron build is deliberately a single supervised process with no sidecars (`resources/` ships only Node), so bundling a JVM + LibreOffice is out of the question. On desktop this tier is simply absent and the drawer falls back to download.
- **Absence is normal.** Consistent with the project's graceful-degradation rule, a missing or unreachable service degrades to download and never fails the preview.

Because of these, the external service is an optional enhancement for the server deployment, not a core dependency of the capability.

### Opening the preview without new protocol

Two references can open the drawer with no WebSocket change: a completed tool block whose call wrote a file (its arguments carry the path — the `ToolBlock` gains a preview affordance), and a link in assistant text that points at the file route (`Markdown.tsx` already overrides anchors; intercept instead of navigating). Both reuse data already flowing.

## Non-goals

- Unifying composer attachment (RAG ingestion) with preview. Noted as follow-up.
- Legacy `.doc`, client-side pptx, media transcription.
- Chart image export (that is the sibling `chat-chart-rendering` change).

## Risks and open questions

- **Serving the agent workspace exposes whatever the agent writes there.** Inherent to previewing produced files; mitigated by read-only access and the content-type/ disposition policy, and bounded to the configured root.
- **`docx` renderers execute in the page unless sandboxed.** The spec requires sandboxing; the implementation must honor it rather than rendering into the main DOM.
- **Reachability for an external service in dev** (container vs host) — an operator/setup concern to document, not a code path.
- **Unifying attach-and-preview** is a real UX question (one gesture or two?) deliberately deferred; the drawer does not depend on the answer.
