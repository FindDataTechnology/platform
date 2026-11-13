## MODIFIED Requirements

### Requirement: The chat view is served by a React SPA under `web/`

The entire frontend (chat, documents, dashboard, chat history, and the embedded OpenConnector + LiteLLM views) SHALL be implemented as a single React + TypeScript single-page application located under `web/`, built by Vite into `web/dist/`. The legacy vanilla frontend under `public/` SHALL be deleted; the server SHALL NOT serve any `public/` assets.

The React app SHALL use client-side routing (`react-router-dom`) with a flat route table: `/chat` (default), `/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`. The root path `/` SHALL redirect to `/chat`. The sidebar navigation SHALL use in-app `<Link>` components (not `<a href>`) so navigation does not reload the page or drop the WebSocket connection.

#### Scenario: React app serves all routes
- **WHEN** a browser requests `/chat`, `/documents`, `/dashboard`, `/history`, `/openconnector`, or `/litellm`
- **THEN** the server SHALL respond with `web/dist/index.html`
- **AND** the React router SHALL render the matching view client-side

#### Scenario: Root path routes to chat
- **WHEN** a browser requests `/`
- **THEN** the server SHALL respond with `web/dist/index.html`
- **AND** the React router SHALL redirect to `/chat`

#### Scenario: No legacy frontend remains
- **WHEN** a browser requests any path
- **THEN** the server SHALL NOT serve files from a `public/` directory
- **AND** no `public/index.html` or `public/app.js` SHALL exist in the repository

#### Scenario: Sidebar navigation does not reload the page
- **WHEN** the user clicks a sidebar nav item (e.g. Documents)
- **THEN** the URL SHALL change to `/documents` via the History API
- **AND** the page SHALL NOT perform a full browser navigation
- **AND** the WebSocket connection SHALL remain open across the navigation

#### Scenario: Sidebar links cover every view
- **WHEN** the React sidebar renders
- **THEN** the Chat link SHALL target `/chat`
- **AND** the Documents link SHALL target `/documents`
- **AND** the Dashboard link SHALL target `/dashboard`
- **AND** the Chat History link SHALL target `/history`
- **AND** the OpenConnector link SHALL target `/openconnector`
- **AND** the LiteLLM link SHALL be present with target `/litellm` only when `/api/config` reports `litellmEnabled: true`

### Requirement: A single build step produces the frontend

`npm install` at the repo root SHALL leave the project runnable in production mode without further manual steps. `npm run build` at the repo root SHALL produce `web/dist/`. A `postinstall` script SHALL install and build `web/` unless the environment variable `PLATFORM_SKIP_WEB_BUILD=1` is set or `web/dist/index.html` already exists.

#### Scenario: Fresh install produces a runnable app
- **WHEN** a contributor runs `npm install` in a fresh clone
- **THEN** `web/dist/index.html` SHALL exist after the install completes
- **AND** `npm start` SHALL serve the React app at `/` without any additional build step

#### Scenario: Skipping the frontend build is opt-in
- **WHEN** `PLATFORM_SKIP_WEB_BUILD=1` is set during `npm install`
- **THEN** the `postinstall` script SHALL NOT run the frontend build

#### Scenario: Existing dist is not rebuilt on repeat install
- **WHEN** `npm install` runs and `web/dist/index.html` already exists
- **THEN** the `postinstall` script SHALL NOT re-run the frontend build

## ADDED Requirements

### Requirement: The server serves the built frontend at root

`server.js` SHALL serve `web/dist/` as the static root at `/` (with Vite's hashed assets under `/assets/*`). It SHALL NOT serve a separate legacy frontend. The `/oc-web` reverse proxy and `/api/*` REST routes SHALL continue to be mounted alongside the static serving. The `/` -> `/chat/` redirect SHALL be removed.

#### Scenario: Static root serves the React bundle
- **WHEN** a browser requests `/` or `/assets/<hash>.js`
- **THEN** the server SHALL respond from `web/dist/`
- **AND** no redirect to `/chat/` SHALL occur

#### Scenario: API and proxy routes are unaffected
- **WHEN** a browser requests `/api/documents`, `/api/chat-history/*`, `/api/openconnector/*`, or `/oc-web`
- **THEN** those routes SHALL continue to behave as before the migration
