# web-search Specification

## Purpose

Gives the agent real-time web access through two first-party tools — `web_search` (served by the operator's key-pooling search relay) and `web_read` (local page fetch + text extraction) — available in every deployment form with zero customer configuration, degrading explicitly when the relay is unconfigured or unreachable.

## Requirements

### Requirement: Agent can search the web through a single normalized tool
The platform SHALL expose a `web_search` tool (callable name `mcp__websearch__web_search`) to every persona preset. It SHALL accept a natural-language query and an optional result-count limit, and SHALL return a normalized result list where each entry carries at least `title`, `url`, and `snippet`. The tool contract SHALL be identical regardless of which upstream engine the relay used, and the model SHALL NOT be asked to choose an engine.

#### Scenario: Query returns normalized results
- **WHEN** the agent calls `mcp__websearch__web_search` with a query
- **THEN** the tool SHALL return a list of results, each with `title`, `url`, and `snippet`
- **AND** the response SHALL NOT expose engine-specific envelopes or require engine knowledge to consume

#### Scenario: Upstream failover is invisible
- **WHEN** the relay serves the query from any upstream in its pool (e.g. a SerpAPI key or the GLM fallback)
- **THEN** the tool's input contract and normalized output shape SHALL be unchanged

### Requirement: Agent can read a web page locally
The platform SHALL expose a `web_read` tool (callable name `mcp__websearch__web_read`) that accepts an `http`/`https` URL, fetches it from the deployment's own network egress, and returns extracted readable text rather than raw HTML. The tool SHALL bound both fetch time and returned text size, and SHALL refuse non-`http(s)` schemes explicitly.

#### Scenario: URL returns readable text
- **WHEN** the agent calls `mcp__websearch__web_read` with an `https` URL
- **THEN** the tool SHALL return the page's extracted readable text
- **AND** the returned text SHALL NOT be the raw HTML source

#### Scenario: Non-http scheme is refused
- **WHEN** the agent calls the tool with a scheme other than `http`/`https`
- **THEN** the tool SHALL return an explicit error without performing a fetch

#### Scenario: Private-network targets are refused
- **WHEN** the agent calls the tool with a URL whose host is a private, loopback, or local-network address
- **THEN** the tool SHALL return an explicit error without performing the fetch

#### Scenario: Oversized page is truncated
- **WHEN** the fetched page's extracted text exceeds the configured size bound
- **THEN** the tool SHALL return truncated text and SHALL indicate truncation

#### Scenario: Unreachable page fails bounded
- **WHEN** the URL does not respond within the fetch timeout
- **THEN** the tool SHALL return an explicit timeout error
- **AND** the agent's turn SHALL continue (no hang, no crash)

### Requirement: Search ships enabled in every deployment form with zero customer configuration
The web-search tools SHALL be present and enabled in the effective tool roster on first startup of every deployment form — dev server, packaged desktop app, and hosted cloud cell — without any customer-side account, key, or configuration action. The capability SHALL remain manageable through the existing extensions surface (disable/re-enable) and discoverable through the existing tool-discovery layer. Demo and sandbox users SHALL have the same access as full users.

#### Scenario: Fresh cloud cell has search
- **WHEN** a hosted cell boots for the first time for a new user
- **THEN** `mcp__websearch__web_search` and `mcp__websearch__web_read` SHALL appear in the effective tool roster

#### Scenario: No customer credentials required
- **WHEN** a customer deployment has never configured any search-provider credential
- **THEN** `web_search` SHALL still be functional (all upstream provider keys live at the operator's relay)

#### Scenario: Admin can disable the capability
- **WHEN** an administrator disables the bundled web-search server through the extensions surface
- **THEN** its tools SHALL disappear from the effective roster and from tool-discovery results

### Requirement: Relay client contract keeps provider credentials operator-side
The platform SHALL talk to exactly one configurable search-relay endpoint (`SEARCH_RELAY_URL`) authenticated with a single relay token (`SEARCH_RELAY_TOKEN`) sent as a Bearer header. No upstream search-provider key (SerpAPI, GLM, or successor) SHALL appear in the repository, the bundle, any deployment's client-visible surface, or any environment variable of a customer deployment other than the relay pair.

#### Scenario: Only the relay pair is configured
- **WHEN** the deployment's environment is inspected
- **THEN** the only search-related credentials present SHALL be `SEARCH_RELAY_URL` and `SEARCH_RELAY_TOKEN`

#### Scenario: Request shape is stable
- **WHEN** the platform calls the relay
- **THEN** the call SHALL be `POST <SEARCH_RELAY_URL>/v1/search` with a JSON body containing the query and optional result-count limit, and an `Authorization: Bearer <SEARCH_RELAY_TOKEN>` header

### Requirement: Search degrades explicitly without breaking the turn
When the relay is unconfigured, unreachable, or returns an error, `web_search` SHALL return an explicit, agent-readable unavailability error within a bounded time, and the surrounding agent turn SHALL continue. `web_read` SHALL be unaffected by relay availability because it performs no relay calls.

#### Scenario: Unconfigured relay yields explicit error
- **WHEN** `SEARCH_RELAY_URL` or `SEARCH_RELAY_TOKEN` is not set and the agent calls `web_search`
- **THEN** the tool SHALL return an error stating that search is not configured, rather than attempting a network call
- **AND** `web_read` SHALL remain fully functional

#### Scenario: Relay outage fails bounded
- **WHEN** the relay is unreachable or returns a server error
- **THEN** `web_search` SHALL return an explicit error within the configured timeout
- **AND** no partial or malformed result list SHALL be returned as if it were valid
