## ADDED Requirements

### Requirement: Sessions record the workspace they ran in
The session mirror SHALL stamp the runtime workspace on a session when its
first turn is mirrored and SHALL NOT change it afterwards, including when
the runtime workspace is switched mid-conversation. The sessions list
payload and the `sessions` WebSocket broadcast SHALL include the recorded
workspace (absent for sessions created before this capability). The
underlying storage change SHALL be an additive migration.

#### Scenario: first turn stamps the workspace
- **WHEN** a new session's first user turn is mirrored while the runtime
  workspace is `/home/me/paas`
- **THEN** the session record carries `/home/me/paas` and the sessions
  broadcast includes it

#### Scenario: workspace switch mid-session does not re-stamp
- **WHEN** the user switches the runtime workspace and continues the same
  session
- **THEN** the session's recorded workspace is unchanged

#### Scenario: pre-existing sessions have no workspace
- **WHEN** the sessions payload includes rows created before this capability
- **THEN** those rows carry no workspace value and clients render them under
  the Ungrouped group
