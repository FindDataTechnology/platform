# llm-model-management Specification

## Purpose
The Models page (`/models`) is the first-class surface for managing LLM providers and their models. The page lists providers configured in the dsh `settings.yaml`, allows adding/editing/removing providers, testing live connections, and selecting the default model. The dsh-llm plugin is the underlying mechanism — this capability is the UI + REST surface that drives it.

## ADDED Requirements

### Requirement: Server exposes LLM provider CRUD endpoints
The server SHALL expose the following REST endpoints under `/api/llm/`:
- `GET /api/llm/providers` — return every configured provider as `{ id, name, baseUrl, hasKey, type, models: string[], lastTest: { ok, latencyMs, error?, at } | null }[]`. The API key SHALL NEVER be returned; only `hasKey: true|false`.
- `POST /api/llm/providers` — create a new provider. Body: `{ name, baseUrl, apiKey, type }`. Writes a patch to `settings.yaml`, then calls `dshBridge.restart({ profilePatchPath })`. Returns the new provider record.
- `PUT /api/llm/providers/:id` — edit an existing provider. Same body as POST (partial updates allowed). Same write-and-restart flow.
- `DELETE /api/llm/providers/:id` — remove a provider. Refuses with 409 if it is the only configured provider (must keep at least one to remain functional).
- `POST /api/llm/providers/:id/test` — probe the provider's base URL. Returns `{ ok, latencyMs, error? }`.
- `GET /api/llm/default` — return `{ providerId, modelId }`.
- `PUT /api/llm/default` — body `{ providerId, modelId }`. Returns the new default. Does NOT restart dsh; the default pointer is read on next session prompt.

Concurrent edit attempts SHALL be serialized via an in-process mutex; a competing request gets HTTP 409 with `{ error: "another edit in progress" }`. The mutex SHALL be released on success and on failure.

#### Scenario: list providers
- **WHEN** the client sends `GET /api/llm/providers`
- **THEN** the server SHALL return every provider with its id, name, baseUrl, hasKey, type, models, and lastTest
- **AND** SHALL NOT include the apiKey in any form

#### Scenario: add a provider
- **WHEN** the client sends `POST /api/llm/providers` with a valid body
- **THEN** the server SHALL validate the name is unique, write the patch to settings.yaml
- **AND** restart dsh with the new profile
- **AND** return the new provider record
- **AND** broadcast a `models` WS event so the sidebar model selector updates

#### Scenario: delete the only provider is rejected
- **WHEN** the client sends `DELETE /api/llm/providers/:id` and `:id` is the only remaining provider
- **THEN** the server SHALL return HTTP 409 with `{ error: "cannot delete the only configured provider" }`
- **AND** no settings.yaml change SHALL be made

### Requirement: Test endpoint probes provider reachability
`POST /api/llm/providers/:id/test` SHALL perform a lightweight probe of the provider's base URL. For OpenAI-compatible providers, the probe SHALL be a `GET <baseUrl>/models` with the API key in the `Authorization: Bearer` header. A 2xx response within 5 seconds counts as success; the response SHALL include `latencyMs`. On any non-2xx or timeout, the response SHALL include `ok: false` and a sanitized `error` string (the response body SHALL be truncated to 200 characters and SHALL NOT include the API key).

#### Scenario: successful probe
- **WHEN** the user clicks Test on a provider whose base URL is reachable
- **THEN** the endpoint SHALL return `{ ok: true, latencyMs: <number> }`
- **AND** the UI SHALL show a green check with the latency

#### Scenario: failed probe
- **WHEN** the user clicks Test on a provider whose base URL is unreachable
- **THEN** the endpoint SHALL return `{ ok: false, error: "..." }` with the error message
- **AND** the UI SHALL show a red cross with the error

### Requirement: API keys are never exposed
No endpoint SHALL return the configured API key. The `hasKey` boolean is the only signal exposed to the client. The UI for editing a provider SHALL show a placeholder ("API key (leave blank to keep current)") and SHALL submit the new key only when the field is non-empty; an empty field on edit means "keep the existing key". Logs SHALL NEVER include the API key value.

#### Scenario: apiKey is masked on read
- **WHEN** the client fetches the provider list
- **THEN** no provider record SHALL include the apiKey field
- **AND** `hasKey: true` SHALL be present when a key is configured
- **AND** `hasKey: false` SHALL be present when no key is configured

### Requirement: Models page lists providers with cards
The Models page SHALL render one card per provider, showing name, type, base URL (truncated), hasKey indicator (🔒 / 🔓), connection status (last test result with relative timestamp), and a list of discovered model ids. Each card SHALL have buttons: **Edit**, **Test**, **Delete** (with confirm). Above the card list, the page SHALL have an **Add provider** button and a **Set default** affordance that shows the current default model id and links to the per-card "Set as default" action.

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
- **WHEN** the user clicks Delete on a provider card
- **THEN** a confirmation dialog SHALL appear
- **WHEN** the user confirms
- **THEN** the client SHALL call `DELETE /api/llm/providers/:id`
- **AND** the card SHALL disappear on success

### Requirement: Default model pointer
The page SHALL display the current default model id (provider + model) and SHALL allow the user to change it via a per-card "Set as default" action. Changing the default SHALL call `PUT /api/llm/default` and SHALL NOT restart dsh. The change SHALL be reflected in the sidebar's current-model indicator after the next WS `model_changed` event.

#### Scenario: change default
- **WHEN** the user clicks "Set as default" on a model within a provider card
- **THEN** the client SHALL call `PUT /api/llm/default` with the chosen provider+model id
- **AND** the page SHALL show the new default highlighted
- **AND** the sidebar model indicator SHALL update after the WS `model_changed` event
