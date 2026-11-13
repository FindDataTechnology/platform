## MODIFIED Requirements

### Requirement: The chat view is served by a React SPA under `web/`

The chat surface (sidebar, message log, composer) SHALL be implemented as a React + TypeScript single-page application located under `web/` at the repository root. Its build output SHALL be produced by Vite and written to `web/dist/`. Views other than the chat surface MAY remain on the legacy vanilla `public/` frontend until they are ported by follow-up changes.

The React sidebar SHALL link each non-chat navigation item to the legacy view's own path (`/documents`, `/openconnector`, `/dashboard`, and — when `litellmEnabled` — `/litellm`). It SHALL NOT link non-chat items to `/`, because `/` redirects to `/chat/` and would trap the user in the chat view.

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

#### Scenario: Sidebar links point at each view's own path
- **WHEN** the React sidebar renders
- **THEN** the Documents link SHALL target `/documents`
- **AND** the OpenConnector link SHALL target `/openconnector`
- **AND** the Dashboard link SHALL target `/dashboard`
- **AND** the LiteLLM link SHALL be present with target `/litellm` only when `/api/config` reports `litellmEnabled: true`
- **AND** no non-chat sidebar link SHALL target `/`
