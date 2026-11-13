## REMOVED Requirements

### Requirement: Provider model sync discovers and classifies serving models
**Reason**: The requirement carved the reserved env route out as dry-run-only, which is exactly the gap this change closes — the built-in lane could not be reconciled against gateway drift at runtime, forcing image rebuilds or in-pod surgery.
**Migration**: Replaced by "Provider model sync reconciles every provider including the reserved route" below; classification semantics for user-managed providers are unchanged, and the reserved route's sync now persists into its override roster.

## ADDED Requirements

### Requirement: Provider model sync reconciles every provider including the reserved route

The server SHALL expose `POST /api/llm/providers/:id/sync` (admin-gated) which reconciles a provider's model roster against the provider's own gateway. Sync SHALL: fetch the full id list from `GET <baseUrl>/models`, then probe each id with a single minimal chat completion (bounded concurrency, per-probe timeout), classify each id as exactly one of `serving`, `unauthorized`, `upstream_down`, `rate_limited`, `not_chat`, or `error`, merge `serving` ids into the provider's model roster, and persist the full per-id status map on the provider record. Sync SHALL NOT delete existing roster entries whose probe did not serve. The response SHALL include the classification summary; probe error strings SHALL be sanitized (no API key, bounded length) before persistence or return.

Sync SHALL apply identically to the reserved env-generated route: serving ids merge into that route's persisted override roster (see "Reserved env route is runtime-overridable"), and its status map persists, so the built-in lane reconciles against gateway drift through the same operator action. A sync SHALL NOT write the route's API key or delete the route.

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

#### Scenario: sync persists on the reserved env route

- **WHEN** an admin triggers sync on the reserved env-generated provider route
- **THEN** the server SHALL classify every listed id and persist `serving` ids into the route's override roster with the per-id status map
- **AND** the change SHALL reach connected clients via the models broadcast without a restart
- **AND** the route's API key and existence SHALL be untouched

#### Scenario: metadata comes from the local family table

- **WHEN** a `serving` id is merged whose family is known to the local metadata table
- **THEN** the merged entry SHALL carry the table's contextWindow/maxTokens/reasoningEfforts
- **AND** an unknown family SHALL get conservative defaults (128k context, 8192 maxTokens, no reasoning efforts)
- **AND** sync SHALL NOT alter metadata fields of entries already present in the roster

### Requirement: Reserved env route is runtime-overridable

The env-generated provider route SHALL support a persisted operator override covering its model roster and base URL. Resolution precedence SHALL be: override value > environment variable > image-built-in default. The override SHALL persist across restarts in the deployment's data dir, SHALL be admin-gated to mutate, and SHALL apply through the existing hot-reload path (no dsh restart, no image rebuild). The route's API key SHALL come exclusively from the environment: no endpoint SHALL accept or persist a key for the reserved route. Clearing the override SHALL restore the environment/built-in projection and is the rollback path.

#### Scenario: override wins over the baked roster

- **WHEN** an override roster exists for the reserved route
- **THEN** the effective roster SHALL be exactly the override's entries
- **AND** the built-in roster SHALL have no effect until the override is cleared

#### Scenario: base-URL override redirects the lane

- **WHEN** the override sets a base URL differing from the environment's
- **THEN** the route's requests and sync probes SHALL target the override URL
- **AND** `GET /api/llm/providers` SHALL surface the effective URL with an override indicator

#### Scenario: clearing the override rolls back

- **WHEN** an admin clears the override
- **THEN** the route SHALL fall back to the environment/built-in roster and URL
- **AND** connected clients SHALL receive the refreshed model list without a restart

#### Scenario: key mutations on the reserved route are refused

- **WHEN** a mutation attempts to set or change the reserved route's API key or delete the route
- **THEN** the server SHALL reject it with an error naming the reserved semantics
- **AND** no stored state SHALL change

## MODIFIED Requirements

### Requirement: Provider model list is editable at runtime

`PUT /api/llm/providers/:id` SHALL accept a `models` array replacing the provider's roster: entries carry `id` plus optional `name`/`contextWindow`/`maxTokens` (absent fields fall back to the family table, then conservative defaults). The mutation SHALL validate ids are unique non-empty strings, run through the same write lock + hot-reload path as other provider edits, and take effect without a restart or image rebuild. This SHALL apply to the reserved env-generated route through its override roster. The Models page SHALL expose a per-provider model-list editor (add id, remove entry, set default pointer, edit each entry's `contextWindow` and `maxTokens`) restricted to admin users.

#### Scenario: operator adds a model without a rebuild

- **WHEN** an admin PUTs a provider record whose `models` array contains a new id
- **THEN** the stored roster SHALL include it with family-table or provided metadata
- **AND** the models WS broadcast SHALL refresh connected clients' pickers without a dsh restart
- **AND** no image build, config-map change, or pod intervention SHALL be required

#### Scenario: operator edits the reserved route's roster without a rebuild

- **WHEN** an admin PUTs the reserved env-generated route with a `models` array
- **THEN** the override roster SHALL replace the previous override (the image's built-in roster remains the fallback once the override is cleared)
- **AND** the effective roster SHALL refresh via the hot-reload path with no restart

#### Scenario: invalid models payload rejected

- **WHEN** the `models` payload has duplicate ids, empty ids, or a non-array
- **THEN** the server SHALL respond HTTP 400 and leave the stored roster unchanged

#### Scenario: per-entry token limits are editable

- **WHEN** an admin sets an entry's `contextWindow` or `maxTokens` in the model-list editor and saves
- **THEN** the stored entry SHALL carry the provided values, validated as positive integers
- **AND** entries with omitted fields SHALL keep family-table or conservative-default values

### Requirement: Models page lists providers with cards

The Models page SHALL render one card per provider, showing name, type, base URL (truncated), hasKey indicator (🔒 / 🔓), connection status (last test result with relative timestamp), and a list of discovered model ids. Each user-managed card SHALL have buttons: **Edit**, **Test**, **Delete** (with confirm). The reserved env-route card SHALL offer **Test**, the model-list editor, and a base-URL override action, and SHALL NOT offer **Delete** or API-key editing; it SHALL carry a persistent visual marker distinguishing it as the deployment's built-in lane. Above the card list, the page SHALL have an **Add provider** button and a **Set default** affordance that shows the current default model id and links to the per-card "Set as default" action.

#### Scenario: provider card shows connection status

- **WHEN** the page renders
- **THEN** each provider card SHALL show a green check or red cross for the last test
- **AND** SHALL show the relative time since the test

#### Scenario: add provider opens form

- **WHEN** the user clicks Add provider
- **THEN** a modal form SHALL open with fields: name, type, baseUrl, apiKey
- **AND** the Save button SHALL be disabled until all required fields are filled
- **WHEN** the user saves
- **THEN** the form SHALL POST to `/api/llm/providers`
- **AND** the page SHALL refetch and the new card SHALL appear

#### Scenario: delete with confirm

- **WHEN** the user clicks Delete on a user-managed provider card
- **THEN** a confirmation dialog SHALL appear
- **WHEN** the user confirms
- **THEN** the client SHALL call `DELETE /api/llm/providers/:id`
- **AND** the card SHALL disappear on success

#### Scenario: reserved card is editable but not deletable

- **WHEN** the page renders the reserved env-route card for an admin
- **THEN** the model-list editor and base-URL override SHALL be available
- **AND** no Delete action and no API-key field SHALL be presented
- **AND** the card SHALL indicate whether an override is active, with an action to clear it (restoring the image/env projection)
