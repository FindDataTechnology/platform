## ADDED Requirements

### Requirement: Registry list reads are complete

When the platform reads a registry list endpoint (`/api/skills`, `/api/servers`,
`/api/agents`), it SHALL retrieve every entry the registry reports, not only the
first page. The registry paginates these endpoints (default page size 20) and
signals continuation via `has_next` alongside `total_count`, `limit`, and
`offset`; a single unpaginated read SHALL NOT be treated as the full set.

#### Scenario: registry holds more entries than one page
- **WHEN** a registry list endpoint reports `total_count` greater than the number of
  entries in the first response and `has_next` is true
- **THEN** the platform SHALL continue reading subsequent pages until `has_next` is false
- **AND** the resulting market snapshot and agent catalog SHALL contain every enabled
  entry, not a prefix of them

#### Scenario: market reflects entries beyond the first page
- **WHEN** an enabled registry agent or MCP server sorts past the first page
- **THEN** it SHALL still appear in `GET /api/catalog` / the Store market listing
- **AND** its absence SHALL NOT depend on registry response ordering

#### Scenario: single-page registry stays one request
- **WHEN** `total_count` fits within the first page and `has_next` is false
- **THEN** the platform SHALL complete the read without issuing additional requests

### Requirement: Truncated registry reads are observable

A registry list read that ends while the registry still reports more entries SHALL
be treated as an incomplete read and SHALL be observable to operators; the platform
SHALL NOT silently accept a partial list as complete.

#### Scenario: truncation is logged
- **WHEN** a list read returns `has_next` true and the caller stops paging
- **THEN** the platform SHALL emit a warning naming the endpoint, `total_count`, and
  the number of entries actually retrieved

#### Scenario: truncated refresh does not masquerade as a complete snapshot
- **WHEN** a refresh cannot obtain the full list
- **THEN** the failure SHALL be distinguishable from a genuinely short registry
- **AND** the existing last-good snapshot behavior SHALL remain unchanged for
  unreachable-registry failures
