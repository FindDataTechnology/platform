## MODIFIED Requirements

### Requirement: Registry market entries are group-scoped per user
`GET /api/extensions/market` SHALL filter registry-sourced entries by group: an entry carrying a non-empty group list SHALL be included only when the requesting user's groups intersect it. Registry entries with empty or absent group metadata SHALL be visible to everyone. Bundled entries SHALL always be visible regardless of the user. When authentication is off, the requester is the machine owner: all entries, gated or not, SHALL be visible — matching the auth-off semantics of administrator gating elsewhere in the platform (a deployment with no identities has no one to exclude).

#### Scenario: group member sees gated entry
- **WHEN** a registry MCP entry lists groups `["mcp-jira-users"]` and the requesting user's groups include `mcp-jira-users`
- **THEN** the market response SHALL include that entry

#### Scenario: non-member does not see gated entry
- **WHEN** a registry MCP entry lists groups `["mcp-jira-users"]` and the requesting user's groups do not include it
- **THEN** the market response SHALL omit that entry

#### Scenario: bundled entries unaffected by auth mode
- **WHEN** auth is off or the user belongs to no registry groups
- **THEN** bundled catalog entries SHALL still appear in the market response

#### Scenario: auth-off requester sees gated entries
- **WHEN** authentication is off and the registry supplies an entry with groups `["mcp-jira-users"]`
- **THEN** the market response SHALL include that entry, because the requester is the machine owner

## ADDED Requirements

### Requirement: Market installs enforce group admission
Installing a market entry that carries groups SHALL require the requesting user's groups to intersect the entry's groups. This admission SHALL be enforced server-side on the install path for both MCP servers and registry skills — market visibility filtering alone SHALL NOT be the only barrier (a hidden entry could still be installed by calling the API directly with a guessed name). A successful gated MCP install SHALL persist the entry's groups on the installed record as `requiredGroups` so runtime filtering can act on it after installation. Ungated entries (no groups) install exactly as before and SHALL NOT carry `requiredGroups`.

#### Scenario: role holder installs gated MCP entry
- **WHEN** a user whose groups include `mcp-jira-users` installs a market MCP entry carrying groups `["mcp-jira-users"]`
- **THEN** the install SHALL succeed
- **AND** the installed record SHALL carry `requiredGroups: ["mcp-jira-users"]`

#### Scenario: non-member install is rejected
- **WHEN** a user whose groups do not include `mcp-jira-users` submits an MCP install whose name matches a market entry carrying groups `["mcp-jira-users"]`, bypassing the market listing
- **THEN** the server SHALL reject the request with an authorization error
- **AND** no MCP record SHALL be created

#### Scenario: registry skill install enforces the same admission
- **WHEN** a user without a matching group installs a registry skill whose entry carries groups
- **THEN** the install SHALL be rejected with an authorization error
- **AND** no skill SHALL be created

#### Scenario: auth-off install is unrestricted
- **WHEN** authentication is off and a market entry carries groups
- **THEN** the install SHALL succeed
- **AND** the installed record SHALL carry the entry's groups as `requiredGroups`
