# Delta: add-resource-filters — resource-library

## MODIFIED Requirements

### Requirement: Resource management API

The cell SHALL expose a REST surface for the library: list (with type filtering, text search over titles, pagination, a creation-time window, and type-group filtering by file kind), save a workspace file, rename, and delete. The list SHALL accept a creation-time window as absolute `since`/`until` timestamps and a set of type groups: the chart group (matching `type=chart`) plus file groups derived from the file's extension — document, spreadsheet, image, slideshow, archive, web, data, other — under a single server-side extension→group mapping shared by every caller. A resource SHALL match the group filter when its own group is among the selected groups. The surface SHALL additionally expose per-group counts (charts counted in the chart group) computed against the active creation-time window and title search but independently of the type-group selection. Chart payloads SHALL be included in list responses so a client can render charts without a second request. Every mutation SHALL be reflected to connected clients of that cell as a library-change event, so open lists and counts reconcile without a manual reload. For bound charts the surface SHALL additionally expose: attach a binding (from a retained candidate), detach a binding, trigger a refresh, set a binding's refresh rule (TTL and cron), and list a bound chart's observation timeline with its as-of reconstruction query — each mutation broadcast through the same library-change event mechanism. Requests that are not authenticated as the cell's user SHALL be rejected by the existing cell auth gate. All routes SHALL be accessible with the same credentials as the rest of the client API — no new auth mechanism is introduced.

#### Scenario: list, filter, and search

- **WHEN** a client lists resources with a type filter or a title query
- **THEN** only matching resources are returned, most recent first, with pagination metadata

#### Scenario: rename and delete round-trip

- **WHEN** a client renames a resource
- **THEN** the new title is persisted and included in subsequent listings
- **WHEN** a client deletes a resource
- **THEN** it disappears from listings and its stored bytes (for files) are removed

#### Scenario: an open client sees a capture arrive

- **WHEN** a chart is captured while a client has the library open
- **THEN** the client receives the library-change event and can show it without a manual reload

#### Scenario: binding mutations round-trip through the API

- **WHEN** a client attaches a binding from a retained candidate, sets a refresh rule, and triggers a refresh
- **THEN** all three are reflected in the resource's subsequent listings
- **AND** the observation timeline endpoint returns the refresh that just ran

#### Scenario: an unauthenticated refresh request is rejected

- **WHEN** a request to any of the binding or refresh routes arrives without the cell's identity
- **THEN** it is rejected by the existing auth gate, not by new logic

#### Scenario: time window and type groups combine

- **WHEN** a client lists resources with a creation-time window of the last 7 days and the document and spreadsheet groups selected
- **THEN** only file resources created inside the window whose extension maps to document or spreadsheet are returned, most recent first

#### Scenario: facet counts follow the window, not the group selection

- **WHEN** a client requests group counts with a creation-time window set and only the document group selected
- **THEN** counts are returned for every group, narrowed by the window and title search, including groups that are not selected
