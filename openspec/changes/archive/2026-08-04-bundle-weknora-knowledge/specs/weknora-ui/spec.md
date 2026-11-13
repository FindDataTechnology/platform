## ADDED Requirements

### Requirement: WeKnora UI is accessible via the React SPA's sidebar navigation
The React SPA SHALL expose a "WeKnora" entry in the sidebar (using `<NavLink>` like the existing Chat, Documents, OpenConnector, LiteLLM entries) that navigates to the `/weknora` route. The route SHALL render an iframe wrapper component that loads WeKnora's native web UI via the same-origin `/weknora-web` reverse proxy.

#### Scenario: user navigates to WeKnora via sidebar
- **WHEN** the user clicks the "WeKnora" sidebar entry
- **THEN** the React router SHALL navigate to `/weknora`
- **AND** the page SHALL render an iframe pointing to `/weknora-web`
- **AND** the iframe SHALL load WeKnora's native web UI

#### Scenario: WeKnora is not configured
- **WHEN** the user navigates to `/weknora` and `WEKNORA_BASE_URL` is not configured
- **THEN** the page SHALL display a "WeKnora is not configured" placeholder (like the OpenConnector and LiteLLm pages when their URLs are unset)
- **AND** SHALL NOT render an iframe

### Requirement: WeKnora UI replaces the first-party Documents page
The old first-party React Documents page (upload forms, document list, indexing status, query interface) SHALL be removed. The `/documents` route SHALL be removed from the React router. The sidebar entry formerly labeled "Documents" SHALL be relabeled "WeKnora" and point to `/weknora`.

#### Scenario: Documents route is removed
- **WHEN** a user navigates to `/documents`
- **THEN** the React router SHALL NOT match the route
- **AND** SHALL fall through to the SPA catch-all (404 or redirect)

#### Scenario: sidebar label is updated
- **WHEN** the user views the sidebar
- **THEN** the entry SHALL be labeled "WeKnora" (not "Documents")
- **AND** SHALL navigate to `/weknora` (not `/documents`)

### Requirement: WeKnora UI is embedded via same-origin iframe proxy
The WeKnora UI SHALL be embedded via the `/weknora-web` same-origin reverse proxy (like `/oc-web` for OpenConnector and `/litellm-web` for LiteLLM). The proxy SHALL inject the WeKnora API token into requests so the browser never sees credentials. The iframe SHALL load the full WeKnora web UI (knowledge bases, document management, chat, Wiki mode, settings).

#### Scenario: iframe loads WeKnora UI
- **WHEN** the user navigates to `/weknora`
- **THEN** the iframe SHALL load `http://localhost:<weknora-port>/` via the `/weknora-web` proxy
- **AND** the proxy SHALL inject the `WEKNORA_API_KEY` into requests
- **AND** the browser SHALL NOT see the API key

#### Scenario: WeKnora UI is fully functional
- **WHEN** the user interacts with the WeKnora UI in the iframe
- **THEN** all WeKnora features SHALL be available (knowledge base creation, document upload, chat, Wiki mode, settings)
- **AND** the UI SHALL communicate with WeKnora's REST API via the proxy
