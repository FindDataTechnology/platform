## MODIFIED Requirements

### Requirement: Role-based visibility

An entry with a non-empty `roles` array SHALL be included in `GET /api/catalog` only when the requesting user's groups intersect the entry's `roles`. Entries with empty or absent `roles` SHALL be visible to everyone. When authentication is off, the requester is the machine owner and all entries SHALL be visible — matching the auth-off owner semantics of administrator gating and market visibility filtering (a deployment with no identities has no one to exclude).

#### Scenario: Role-gated entry hidden from plain users

- **WHEN** a user with groups `["dev"]` requests the catalog and an entry declares `roles: ["admin"]`
- **THEN** that entry is absent from the response

#### Scenario: Auth-off requester sees role-gated entries

- **WHEN** authentication is off and the catalog contains entries declaring `roles`
- **THEN** those entries are present in the response, because the requester is the machine owner
