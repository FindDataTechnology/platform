## ADDED Requirements

### Requirement: Provider model sync discovers and classifies serving models

The server SHALL expose `POST /api/llm/providers/:id/sync` (admin-gated) which reconciles a provider's model roster against the provider's own gateway. Sync SHALL: fetch the full id list from `GET <baseUrl>/models`, then probe each id with a single minimal chat completion (bounded concurrency, per-probe timeout), classify each id as exactly one of `serving`, `unauthorized`, `upstream_down`, `rate_limited`, `not_chat`, or `error`, merge `serving` ids into the provider's model roster, and persist the full per-id status map on the provider record. Sync SHALL NOT delete existing roster entries whose probe did not serve. The response SHALL include the classification summary; probe error strings SHALL be sanitized (no API key, bounded length) before persistence or return.

#### Scenario: sync classifies and merges

- **WHEN** an admin triggers sync on a provider whose gateway lists serving, unauthorized, and upstream-down ids
- **THEN** the server SHALL return a per-id status map covering every listed id
- **AND** the provider's model roster SHALL contain every id classified `serving` that was not already present, appended with family-table default metadata
- **AND** a subsequent `GET /api/llm/providers` SHALL expose the status map and roster

#### Scenario: sync never evicts on a bad probe

- **WHEN** an id already in the provider's roster is classified other than `serving`
- **THEN** the roster entry SHALL remain, and the status map SHALL flag it
- **AND** the Models page SHALL render it with a non-selectable-status indication distinct from serving entries

#### Scenario: classifier-shaped id

- **WHEN** a probed id answers HTTP 200 with empty/whitespace content
- **THEN** the id SHALL be classified `not_chat` and SHALL NOT be merged into the roster

#### Scenario: concurrent sync rejected

- **WHEN** a sync is already running for any provider and another mutation or sync arrives
- **THEN** the server SHALL respond HTTP 409 with the busy error, and the running sync SHALL be unaffected

#### Scenario: reserved env route is dry-run only

- **WHEN** an admin triggers sync on the reserved env-generated provider route
- **THEN** the server SHALL classify and return the would-be changes
- **AND** SHALL NOT modify any stored roster or setting

#### Scenario: metadata comes from the local family table

- **WHEN** a `serving` id is merged whose family is known to the local metadata table
- **THEN** the merged entry SHALL carry the table's contextWindow/maxTokens/reasoningEfforts
- **AND** an unknown family SHALL get conservative defaults (128k context, 8192 maxTokens, no reasoning efforts)
- **AND** sync SHALL NOT alter metadata fields of entries already present in the roster

### Requirement: Provider model list is editable at runtime

`PUT /api/llm/providers/:id` SHALL accept a `models` array replacing the provider's roster: entries carry `id` plus optional `name`/`contextWindow`/`maxTokens` (absent fields fall back to the family table, then conservative defaults). The mutation SHALL validate ids are unique non-empty strings, run through the same write lock + hot-reload path as other provider edits, and take effect without a restart or image rebuild. The Models page SHALL expose a per-provider model-list editor (add id, remove entry, set default pointer) restricted to admin users.

#### Scenario: operator adds a model without a rebuild

- **WHEN** an admin PUTs a provider record whose `models` array contains a new id
- **THEN** the stored roster SHALL include it with family-table or provided metadata
- **AND** the models WS broadcast SHALL refresh connected clients' pickers without a dsh restart
- **AND** no image build, config-map change, or pod intervention SHALL be required

#### Scenario: invalid models payload rejected

- **WHEN** the `models` payload has duplicate ids, empty ids, or a non-array
- **THEN** the server SHALL respond HTTP 400 and leave the stored roster unchanged
