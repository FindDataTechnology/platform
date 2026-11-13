# chat-ui-shell Specification

## Purpose

Defines the frontend shell that hosts the chat surface: what technology stack it uses, where it lives in the repository, how the server serves it, and how it coexists with the legacy vanilla views during the incremental migration. This capability is scoped to the *shell* (toolchain, module structure, static-serving contract, view-migration boundary). It does not restate the behavioral contracts of chat streaming, tool rendering, model selection, skills, or slash commands — those live in their existing specs and are preserved verbatim.

## Requirements

### Requirement: The chat view is served by a React SPA under `web/`

The chat surface (sidebar, message log, composer) SHALL be implemented as a React + TypeScript single-page application located under `web/` at the repository root. Its build output SHALL be produced by Vite and written to `web/dist/`. Views other than the chat surface MAY remain on the legacy vanilla `public/` frontend until they are ported by follow-up changes.

#### Scenario: React chat app serves `/chat`
- **WHEN** a browser requests `/chat` or any subpath `/chat/*`
- **THEN** the server SHALL respond with `web/dist/index.html`
- **AND** the referenced assets SHALL be served from `web/dist/`

#### Scenario: Legacy views remain reachable
- **WHEN** a browser requests `/documents`, `/openconnector`, `/dashboard`, or `/litellm`
- **THEN** the server SHALL respond with the legacy `public/index.html`
- **AND** the corresponding view SHALL open (via the legacy client-side hash/tab logic) until its own migration change ports it

#### Scenario: Root path routes to the chat app after cut-over
- **WHEN** a browser requests `/`
- **THEN** the server SHALL redirect to `/chat`

### Requirement: The WebSocket and REST contracts do not change

The migration SHALL preserve every server WebSocket event and REST endpoint documented in the existing capabilities. The React frontend SHALL connect to the same WebSocket URL, handle the same event types, and call the same REST endpoints as the vanilla frontend it replaces.

#### Scenario: WebSocket URL is unchanged
- **WHEN** the React chat app loads
- **THEN** it SHALL open a WebSocket connection at the same path (`/`) the vanilla frontend used
- **AND** the server SHALL NOT introduce a new WebSocket route for the React app

#### Scenario: REST endpoints are called unchanged
- **WHEN** the React chat app requests chat history, documents, or OpenConnector data
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

The Node backend (`server.js`, `mcp-bridge.js`, `documents.js`, `chat-history.js`, `collections.js`, `open-connector.js`, `db.js`, and `electron/**`) SHALL remain plain ES modules with no transpilation step. The introduction of a bundler SHALL be scoped to `web/`.

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
