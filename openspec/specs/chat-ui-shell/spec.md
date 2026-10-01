# chat-ui-shell Specification

## Purpose

Defines the frontend shell that hosts the chat surface: what technology stack it uses, where it lives in the repository, how the server serves it, and how it coexists with the legacy vanilla views during the incremental migration. This capability is scoped to the *shell* (toolchain, module structure, static-serving contract, view-migration boundary). It does not restate the behavioral contracts of chat streaming, tool rendering, model selection, skills, or slash commands — those live in their existing specs and are preserved verbatim.
## Requirements
### Requirement: The chat view is served by a React SPA under `web/`

The chat surface (sidebar, message log, composer) SHALL be implemented as a React + TypeScript single-page application located under `web/` at the repository root. Its build output SHALL be produced by Vite and written to `web/dist/`. Views other than the chat surface MAY remain on the legacy vanilla `public/` frontend until they are ported by follow-up changes.

The React sidebar SHALL link each non-chat navigation item to the legacy view's own path (`/documents`, `/dashboard`). It SHALL NOT link non-chat items to `/`, because `/` redirects to `/chat/` and would trap the user in the chat view.

#### Scenario: React chat app serves `/chat`
- **WHEN** a browser requests `/chat` or any subpath `/chat/*`
- **THEN** the server SHALL respond with `web/dist/index.html`
- **AND** the referenced assets SHALL be served from `web/dist/`

#### Scenario: Legacy views remain reachable
- **WHEN** a browser requests `/documents` or `/dashboard`
- **THEN** the server SHALL respond with the legacy `public/index.html`
- **AND** the corresponding view SHALL open (via the legacy client-side hash/tab logic) until its own migration change ports it

#### Scenario: Root path routes to the chat app after cut-over
- **WHEN** a browser requests `/`
- **THEN** the server SHALL redirect to `/chat`

#### Scenario: Sidebar links point at each view's own path
- **WHEN** the React sidebar renders
- **THEN** the Documents link SHALL target `/documents`
- **AND** the Dashboard link SHALL target `/dashboard`
- **AND** no non-chat sidebar link SHALL target `/`

### Requirement: The WebSocket and REST contracts do not change

The migration SHALL preserve every server WebSocket event and REST endpoint documented in the existing capabilities. The React frontend SHALL connect to the same WebSocket URL, handle the same event types, and call the same REST endpoints as the vanilla frontend it replaces.

#### Scenario: WebSocket URL is unchanged
- **WHEN** the React chat app loads
- **THEN** it SHALL open a WebSocket connection at the same path (`/`) the vanilla frontend used
- **AND** the server SHALL NOT introduce a new WebSocket route for the React app

#### Scenario: REST endpoints are called unchanged
- **WHEN** the React chat app requests chat history or documents data
- **THEN** it SHALL call the existing `/api/*` endpoints with unchanged request and response shapes

### Requirement: A single build step produces the frontend

`npm install` at the repo root SHALL leave the project runnable in production mode without further manual steps. `npm run build` at the repo root SHALL produce `web/dist/`. A `postinstall` script SHALL install and build `web/` unless the environment variable `PLATFORM_SKIP_WEB_BUILD=1` is set or `web/dist/index.html` already exists.

#### Scenario: Fresh install produces a runnable app
- **WHEN** a contributor runs `npm install` in a fresh clone
- **THEN** `web/dist/index.html` SHALL exist after the install completes
- **AND** `npm start` SHALL serve the React chat app at `/chat` without any additional build step

#### Scenario: Skipping the frontend build is opt-in
- **WHEN** `PLATFORM_SKIP_WEB_BUILD=1` is set during `npm install`
- **THEN** the `postinstall` script SHALL NOT run the frontend build

#### Scenario: Existing dist is not rebuilt on repeat install
- **WHEN** `npm install` runs and `web/dist/index.html` already exists
- **THEN** the `postinstall` script SHALL NOT re-run the frontend build

### Requirement: Backend code remains buildless

The Node backend (`server.js`, `mcp-bridge.js`, `documents.js`, `chat-history.js`, `collections.js`, `db.js`, and `electron/**`) SHALL remain plain ES modules with no transpilation step. The introduction of a bundler SHALL be scoped to `web/`.

#### Scenario: Backend has no transpilation
- **WHEN** a maintainer edits a backend module
- **THEN** the edit SHALL take effect on the next `npm start` with no build step

### Requirement: The frontend uses a component library seeded from shadcn/ui

The React frontend SHALL use shadcn/ui components installed as source files under `web/src/components/ui/` via the shadcn CLI, styled with Tailwind CSS v4, and iconized with `lucide-react`. Component source SHALL be checked into the repository (no runtime dependency on a shadcn npm package).

#### Scenario: Components are owned as source
- **WHEN** a shadcn primitive is used in the frontend
- **THEN** its source SHALL exist under `web/src/components/ui/`
- **AND** upgrades SHALL happen by re-running the shadcn CLI, not by bumping an npm dependency version

### Requirement: Electron packaging includes the built frontend

`npm run dist` SHALL invoke the frontend build before running `electron-builder`. The packaged Electron app SHALL load the chat app from `web/dist/` bundled as a normal resource (not inside an asar archive).

#### Scenario: Packaged app serves the built frontend
- **WHEN** a user launches the packaged Electron app
- **THEN** the window SHALL load the React chat app at `/chat`
- **AND** no runtime frontend build step SHALL execute inside the packaged app

### Requirement: The chat viewport is fixed to the browser viewport

The chat surface at `/chat` SHALL occupy exactly the browser viewport height. The sidebar column, message log, and composer SHALL fit inside the viewport at all times; the browser window itself SHALL NOT gain a page-level vertical scrollbar as chat turns accumulate.

The message log and the plan progress panel (see `chat-plan-progress`) SHALL be the only vertically scrolling regions on the chat page. Each scroller's intrinsic minimum height SHALL NOT be allowed to expand its ancestors — parent flex/grid tracks that contain a scroller SHALL declare `min-height: 0` (or equivalent) so `overflow-y` engages instead of pushing content past the viewport. On narrow viewports the plan renders as a dock inside the composer card (see `chat-plan-progress`); that dock belongs to the pinned composer stack and its expansion SHALL NOT move the composer.

The composer SHALL remain visible at the bottom edge of the viewport regardless of message-log content length. It SHALL NOT be inside the scrolling region.

The empty-state placeholder (shown when there are no turns) SHALL be laid out inside the scrolling log so that it does not shift the composer's vertical position.

#### Scenario: Long transcript keeps composer pinned
- **WHEN** the message log contains enough turns that its content exceeds the viewport height
- **THEN** the log scrolls internally and the composer stays anchored to the bottom of the viewport with no page-level scrollbar

#### Scenario: Empty chat keeps composer at the bottom
- **WHEN** the user first opens `/chat` with no turns yet
- **THEN** the composer is positioned at the bottom edge of the viewport and the empty-state hint is centered inside the message-log area, not pushing the composer down

#### Scenario: Window resize preserves the pinned composer
- **WHEN** the browser window is resized (including cross-axis and short viewports)
- **THEN** the chat surface fills exactly the new viewport height and the composer remains visible without a page-level scrollbar

#### Scenario: Plan panel scrolls without a page scrollbar
- **WHEN** the plan progress panel is mounted and its list exceeds the panel height
- **THEN** the panel list SHALL scroll internally and the page SHALL NOT gain a page-level vertical scrollbar

### Requirement: Chat page has a header when turns exist
When the chat page has at least one turn (a session is loaded or in progress), the page SHALL render a **session header** above the message log. The header SHALL contain exactly two elements: an editable title (click-to-edit text input that commits on Enter, cancels on Escape, debounced 300ms) and an overflow (`⋯`) trigger.

Activating the overflow trigger SHALL open the session context menu for the **active** session — the same menu component that opens on right-click of a session row in the sidebar (see `session-list-management`), so there is one menu with two triggers rather than two parallel menus.

The header SHALL NOT display the current model name, the current agent name, or a connection-status dot. That state is reported once elsewhere in the shell: model and agent by the composer control strip (see `chat-composer-controls`), which is on screen whenever a turn can be sent and is also where those values are *changed*; connection status by the sidebar footer row (see `app-navigation`). Repeating them in the header gave the user three places to read the same value and no place to act on it.

The header SHALL be sticky to the top of the chat area and SHALL NOT obscure the message log on scroll.

#### Scenario: header shows the title and the overflow trigger
- **WHEN** the chat page has turns
- **THEN** the session header SHALL display the session title and an overflow (`⋯`) trigger
- **AND** the header SHALL be visible above the message log

#### Scenario: header does not duplicate runtime state
- **WHEN** the session header renders
- **THEN** it SHALL NOT render the current model name, the current agent name, or a connection-status dot
- **AND** the current model and agent SHALL be readable from the composer control strip
- **AND** the connection status SHALL be readable from the sidebar footer row

#### Scenario: overflow trigger opens the session menu
- **WHEN** the user activates the overflow (`⋯`) trigger in the header
- **THEN** the session context menu SHALL open for the currently active session
- **AND** the menu SHALL be the same component and offer the same actions as the menu opened by right-clicking that session's row in the sidebar
- **AND** the menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item

#### Scenario: rename session
- **WHEN** the user clicks the title in the header
- **THEN** the title SHALL become editable
- **WHEN** the user types a new title and presses Enter
- **THEN** the client SHALL send a `rename_session` WS message
- **AND** the server SHALL broadcast a `session_renamed` event
- **AND** all connected clients (including the sender) SHALL update the title in the sidebar session list

#### Scenario: cancel rename
- **WHEN** the user is editing the title and presses Escape
- **THEN** the edit SHALL be cancelled and the original title SHALL be restored

### Requirement: Welcome state is the empty page
When the chat page has no turns, the page SHALL render the Welcome state (see `chat-welcome-state`) instead of an empty message log. The two states (welcome vs in-session) are mutually exclusive — exactly one is visible at a time. The transition is driven by `turns.length === 0` in the chat store.

#### Scenario: switch from welcome to in-session
- **WHEN** the user sends the first message
- **THEN** the welcome state SHALL be replaced by the message log and session header
- **WHEN** the user clears the chat (clearView action)
- **THEN** the in-session state SHALL be replaced by the welcome state

### Requirement: Session-switch broadcasts `session_renamed`
The WS protocol SHALL add a `session_renamed` server event with payload `{ id, title }`. The event MUST be broadcast to every connected client on a successful rename. The client store SHALL update the matching session's title in `sessions[]`. The legacy behavior (no rename event) is preserved for clients on the old protocol — they simply don't update the title until the next `sessions` refresh.

#### Scenario: rename broadcasts to all clients
- **WHEN** client A renames session S to "New title"
- **THEN** every connected client (including A) SHALL receive a `session_renamed` event with `{ id: S, title: "New title" }`
- **AND** each client's `sessions[]` entry for S SHALL reflect the new title

#### Scenario: rename event is sent on WS path too
- **WHEN** a client sends `{ type: "rename_session", id, title }`
- **THEN** the server SHALL broadcast a `session_renamed` event in the same manner as the REST path

