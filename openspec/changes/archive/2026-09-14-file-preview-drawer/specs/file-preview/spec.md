# file-preview Specification

## Purpose

Lets a user view a file inside the application — one the agent produced, one uploaded, or one from their own machine — in a right-side drawer, with a safe serving route and per-type rendering that degrades to download.

## ADDED Requirements

### Requirement: Read-only file serving route over an allowlisted root

The server SHALL expose a read-only endpoint that returns the bytes of a requested file by reference. The requested path SHALL be resolved against a configured root and the resolved real path SHALL be verified to lie within that root before any bytes are read; a request whose resolved path escapes the root SHALL be rejected. The endpoint SHALL NOT accept an absolute path, SHALL NOT follow a symlink out of the root, and SHALL NOT expose files outside the configured root. A missing file SHALL return `404`. The endpoint SHALL NOT write, rename, or delete anything.

#### Scenario: file inside the root is served
- **WHEN** a client requests a file whose resolved path is inside the configured root
- **THEN** the server returns the file's bytes

#### Scenario: traversal attempt is rejected
- **WHEN** a client requests a path containing `..` segments, an absolute path, or a symlink that escapes the root
- **THEN** the server rejects the request without reading any file outside the root

#### Scenario: unknown file
- **WHEN** a client requests a path inside the root that does not exist
- **THEN** the server returns `404`

### Requirement: Served files cannot cause same-origin script execution

The serving route SHALL NOT return active content in a way that executes in the application's origin. For file types not on a safe-type allowlist, the route SHALL force a download disposition (and an opaque content type) rather than rendering them inline. Content whose type the browser would treat as executable or as HTML SHALL NOT be served inline from the application origin.

#### Scenario: uploaded HTML is not served inline
- **WHEN** a file whose content is HTML and whose type is not on the safe allowlist is requested
- **THEN** the response forces a download disposition
- **AND** the browser does not execute it in the application origin

#### Scenario: safe types are served inline
- **WHEN** an image, PDF, or plain-text file is requested
- **THEN** the response is served inline with a conservative content type

### Requirement: A preview drawer displays one file

The web client SHALL provide a right-side drawer that displays a single file at a time. The drawer SHALL be openable from a file reference and closable, and its presence SHALL NOT unmount or disconnect the chat. After the first load, the drawer's code SHALL be loaded on demand so a session that never previews a file does not pay for it.

#### Scenario: open and close the drawer
- **WHEN** the user opens a file reference
- **THEN** the drawer opens showing that file
- **AND** closing the drawer leaves the chat session and its WebSocket intact

#### Scenario: drawer code is not loaded until used
- **WHEN** a session never opens a file preview
- **THEN** the preview drawer's code is not loaded

### Requirement: Per-type rendering with download fallback

The drawer SHALL render by file type: images, PDF, and plain text/markdown through native browser capabilities or existing components; CSV as a table; and `docx` through a client renderer. A type with no renderer SHALL present a download action instead of an error. Rendering a file SHALL NOT require the user to leave the page.

#### Scenario: image, PDF, and text render
- **WHEN** the user previews an image, a PDF, or a text/markdown file
- **THEN** the drawer displays it without a download step

#### Scenario: docx renders
- **WHEN** the user previews a `.docx` file
- **THEN** the drawer renders its content in the drawer

#### Scenario: unrenderable type offers download
- **WHEN** the user previews a file type with no renderer
- **THEN** the drawer offers a download action
- **AND** does not show an error state

### Requirement: Active content renders in a sandbox

When the drawer renders content that can execute or embed markup (for example HTML, or the output of the `docx` renderer), it SHALL do so in a sandboxed context that cannot reach the application origin, its storage, or its WebSocket credentials.

#### Scenario: previewed HTML cannot reach the app
- **WHEN** the drawer renders an HTML file
- **THEN** the content runs in a sandbox that cannot access the application origin or its credentials

### Requirement: Local files preview without server involvement

The client SHALL allow the user to preview a file chosen from their own machine without uploading it. In this path the file's bytes SHALL NOT be sent to the server, and the preview SHALL use a browser-local object reference.

#### Scenario: preview a local file without uploading
- **WHEN** the user chooses a local file to preview without uploading it
- **THEN** the drawer renders it
- **AND** no request carries the file's contents to the server

### Requirement: Long-tail formats delegate to an optional external service with download fallback

When a catalog `external-service` entry for file preview is configured, the drawer SHALL delegate types it cannot render itself to that service. When no such entry is configured, or the service is unreachable, the drawer SHALL fall back to the download action without failing the preview. The external service SHALL be embedded the same way other catalog external services are, and the file reference passed to it SHALL NOT carry application credentials to the browser.

#### Scenario: configured service handles a long-tail format
- **WHEN** a preview service is configured and the user previews a type the client cannot render
- **THEN** the drawer shows the preview produced by that service

#### Scenario: no service configured
- **WHEN** no preview service is configured and the user previews an unrenderable type
- **THEN** the drawer offers download
- **AND** no error is surfaced

#### Scenario: service unreachable
- **WHEN** the configured preview service does not respond
- **THEN** the drawer falls back to the download action
- **AND** the rest of the application remains available

### Requirement: File references open the preview

A file reference in assistant output and a completed tool call that produced a file SHALL each offer to open that file in the drawer, without requiring the user to know a URL or leave the chat.

#### Scenario: open a produced file from the tool block
- **WHEN** a tool call that wrote a file has completed
- **THEN** the tool block offers an action that opens that file in the drawer

#### Scenario: open a linked file from the assistant text
- **WHEN** assistant text links to a file served by the file route
- **THEN** activating the link opens the drawer instead of navigating away
