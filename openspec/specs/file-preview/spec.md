# file-preview Specification

## Purpose

Lets a user view a file inside the application — one the agent produced, one uploaded, or one from their own machine — in a right-side drawer, with a safe serving route and per-type rendering that degrades to download.

## Requirements

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

A file reference in assistant output and a completed tool call that produced a file SHALL each offer to open that file in the drawer, without requiring the user to know a URL or leave the chat. A markdown link in assistant text SHALL open the drawer whenever its target names a file the platform recognizes as a produced file, whether or not the client can render that type; a link naming an unrecognized target, an external URL, or a non-file target SHALL keep its ordinary navigation behavior. For a type the client cannot render, the drawer SHALL present the download action, and SHALL report the file as no longer available rather than offer a download that cannot succeed when the file no longer exists.

#### Scenario: open a produced file from the tool block

- **WHEN** a tool call that wrote a file has completed
- **THEN** the tool block offers an action that opens that file in the drawer

#### Scenario: open a linked file from the assistant text

- **WHEN** assistant text links to a file served by the file route
- **THEN** activating the link opens the drawer instead of navigating away

#### Scenario: a link to an unrenderable produced file opens the drawer

- **WHEN** assistant text links to a produced file whose type has no renderer (for example an archive or a spreadsheet)
- **THEN** activating the link opens the drawer
- **AND** the drawer presents the download action rather than an error or a navigation

#### Scenario: a link to a produced file that no longer exists

- **WHEN** assistant text links to a produced file whose type has no renderer, and that file is no longer present in the workspace
- **THEN** the drawer reports that the file is no longer available instead of offering a download that cannot succeed

#### Scenario: ordinary links keep their behavior

- **WHEN** assistant text links to an external URL or a target that names no produced file
- **THEN** the link keeps its ordinary navigation behavior and does not open the drawer

### Requirement: An attached file opens the preview from its composer chip

A composer attachment chip in the attached state SHALL open its stored original in the preview drawer, using the same drawer and file route as the tool-block and link entry points. This entry point SHALL reference the file through the preview route against the `uploads` root; it SHALL NOT require the file to be in the agent workspace, and it SHALL NOT alter the message being composed.

#### Scenario: open an attachment from the chip
- **WHEN** the user activates an attached file's chip
- **THEN** the drawer opens showing that file's original
- **AND** the composed message and its `@doc:<id>` references are unchanged

#### Scenario: chip entry uses the uploads root
- **WHEN** the drawer resolves an attachment's file
- **THEN** it requests the file against the `uploads` root
- **AND** the agent workspace is not required to contain the file

### Requirement: A file is produced by specific tools, not by any path in a call

Which files a turn produced SHALL be determined by the tool that ran, not by the mere presence of a file path in the call. A tool that creates, modifies, or exports files SHALL contribute the paths it operates on; a tool that reads, lists, or searches files SHALL contribute none; a tool with no declared production behavior SHALL contribute none. A shell tool call SHALL contribute a path from its command string only when the command declares that path as an output — by redirecting into it (only targets that are themselves path-shaped), by invoking a recognized archive, copy, or conversion command, or by running a script-runner command whose text names an archive-shaped path — and SHALL NOT contribute paths named in the command merely as inputs or in the command's output text. A multi-line command SHALL be split per line before segment analysis, and a command segment that introduces a heredoc SHALL be exempt from redirect scanning (a heredoc body is not shell syntax). Characters inside a well-formed quoted span SHALL be treated as literal text, not shell syntax: a separator or redirection inside quotes SHALL NOT split the command, mint a segment boundary, or count as a redirection.

#### Scenario: a tool that writes a file contributes it

- **WHEN** a turn's tool call creates or modifies a workspace file through a file-writing tool
- **THEN** that path is among the files the turn is considered to have produced

#### Scenario: a tool that reads a file contributes nothing

- **WHEN** a turn's tool call reads, lists, or searches files and writes nothing
- **THEN** none of the paths it named is among the files the turn is considered to have produced

#### Scenario: a shell command that redirects contributes its target

- **WHEN** a turn's shell call writes its output into a workspace path by redirection
- **THEN** that path is among the files the turn is considered to have produced

#### Scenario: a shell command that archives contributes the archive

- **WHEN** a turn's shell call runs an archive, copy, or conversion command naming an output file
- **THEN** that output path is among the files the turn is considered to have produced
- **AND** the input files the command consumed are not

#### Scenario: a read-only shell command contributes nothing

- **WHEN** a turn's shell call only reads, queries, or inspects state and writes no file
- **THEN** the turn is considered to have produced no files by that call

#### Scenario: a command's output text is not a source of produced files

- **WHEN** a shell command's output names files (a listing, a match, a log line) that the command did not itself create
- **THEN** those files are not attributed to the turn as produced

#### Scenario: an archive line inside a multi-line command is its own segment

- **WHEN** a turn's shell command spans multiple lines and one line runs an archive command (for example a line following a redirected line)
- **THEN** the archive that line declares is among the files the turn is considered to have produced
- **AND** the redirect target of an earlier line does not swallow the later line's declaration

#### Scenario: a heredoc never mints a redirect candidate

- **WHEN** a turn's shell command embeds a heredoc whose body contains arrow-shaped text (for example `->` inside a print statement)
- **THEN** no part of that heredoc body is attributed as a redirect output
- **AND** the turn does not produce a candidate consisting of code text

#### Scenario: a script runner naming an archive contributes the archive

- **WHEN** a turn's shell command runs a script runner (for example `python3` with a heredoc or `-c` body) whose text names an archive-shaped path it creates
- **THEN** that archive path is among the files the turn is considered to have produced

#### Scenario: a quoted body's separators are not segment boundaries

- **WHEN** a turn's shell command carries a quoted span whose text contains a separator or a redirection (for example a one-line `python3 -c "import zipfile;z=…"` body)
- **THEN** the span is treated as literal text: it neither splits the command nor counts as a redirection
- **AND** the archive the span names is among the files the turn is considered to have produced
