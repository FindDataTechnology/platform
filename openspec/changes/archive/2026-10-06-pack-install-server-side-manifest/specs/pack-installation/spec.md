## ADDED Requirements

### Requirement: Manifest retrieval is server-side

Installing a pack SHALL NOT require the client to transmit the pack manifest. The install endpoint SHALL accept `{packId, version}` and retrieve that version's manifest from the marketplace server-side before running the existing validation and materialization pipeline. A request that still carries a manifest body SHALL continue to be accepted and SHALL be validated by the same rules (rolling compatibility). Retrieval SHALL be performed under the calling user's identity so that private-pack visibility semantics are unchanged. If the manifest cannot be retrieved, the install SHALL fail with a clear error and materialize nothing.

#### Scenario: Client sends only packId and version

- **WHEN** the UI posts `{packId, version}` for a pack whose manifest contains code snippets
- **THEN** the server fetches the manifest from the marketplace, validates it, and materializes the pack exactly as before

#### Scenario: Private pack visibility follows the caller

- **WHEN** a user installs a private pack they are allowed to see
- **THEN** the server-side retrieval is evaluated under that user's identity and succeeds; a user without access gets the same not-found behavior as the market listing

#### Scenario: Retrieval failure installs nothing

- **WHEN** the marketplace is unreachable or the version does not exist
- **THEN** the response reports the failure and no skill, MCP reference, or agent is written

#### Scenario: Body manifest still accepted

- **WHEN** a request includes a manifest body during the compatibility window
- **THEN** it is processed through the identical validation pipeline as a server-retrieved manifest