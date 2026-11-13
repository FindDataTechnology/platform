## ADDED Requirements

### Requirement: Bundle manifest file format
The system SHALL read an optional `platform.bundle.json` at the project root declaring: `components` (per-component `include`: `true | false | "auto"` for `litellm`, `openconnector`, `postgres`), `mcpServers` (name → MCP config + `enabled`), `skills` (array of skill names under `skills/`), and `permissions` (`mcp:<name>` / `skill:<name>` → `{ allow, deny, locked }`). A missing manifest SHALL resolve to the default: all components included, no bundled MCP servers, no bundled skills, no permissions. An invalid manifest (unparseable JSON, unknown component name, unknown top-level key) SHALL fail the build scripts and SHALL cause the runtime to log a clear error and fall back to the default resolution.

#### Scenario: manifest selects a subset of components
- **WHEN** `platform.bundle.json` declares `"components": { "litellm": { "include": false } }` and other components included
- **THEN** bundle resolution reports litellm as excluded and the remaining components as included

#### Scenario: missing manifest resolves to defaults
- **WHEN** no `platform.bundle.json` exists
- **THEN** resolution reports all three components included and empty `mcpServers`, `skills`, and `permissions`

#### Scenario: invalid manifest falls back with an error
- **WHEN** `platform.bundle.json` contains unparseable JSON
- **THEN** build scripts SHALL fail with a clear validation error
- **AND** the runtime logs the error and resolves the default (all components, no bundled extensions)

### Requirement: Component selection override via environment
The `PLATFORM_BUNDLE_COMPONENTS` environment variable SHALL override manifest `components.*` selections: a comma-separated list selects exactly those components, `all` selects all, `none` selects none. The override SHALL apply identically in build scripts, the electron-builder config, and runtime resolution.

#### Scenario: CI override deselects components without editing the manifest
- **WHEN** `PLATFORM_BUNDLE_COMPONENTS=openconnector` is set and the manifest includes all components
- **THEN** resolution reports only openconnector included
- **AND** litellm and postgres resolve to excluded

#### Scenario: postgres auto-resolution follows litellm
- **WHEN** postgres is declared `"include": "auto"` (the default) and litellm resolves to included
- **THEN** postgres resolves to included
- **WHEN** litellm resolves to excluded
- **THEN** postgres resolves to excluded

### Requirement: First-run seeding of bundled extensions
On first run (and idempotently thereafter), the system SHALL seed each manifest `mcpServers` entry into the extensions DB with `origin: "bundled"`, its `enabled` state, and its `locked`/`permissions` metadata, using INSERT-OR-IGNORE semantics so user edits are preserved across restarts and upgrades. Each manifest `skills` entry SHALL be marked as a bundled skill. Seeding SHALL be best-effort: when the extensions DB is unavailable the system logs a warning and continues startup.

#### Scenario: bundled MCP server appears as a pre-installed extension
- **WHEN** the manifest declares an MCP server `fetch` and the app starts with a fresh DB
- **THEN** the extensions DB contains `fetch` with `origin: "bundled"` and enabled state from the manifest
- **AND** the Installed tab lists it like any installed extension

#### Scenario: user edits survive re-seeding
- **WHEN** a bundled extension already exists in the DB with user-modified config or enabled state
- **THEN** re-seeding SHALL NOT overwrite the existing row

#### Scenario: seeding failure does not block startup
- **WHEN** the extensions DB is unavailable during first-run seeding
- **THEN** the system logs a warning and continues startup without bundled extensions seeded

### Requirement: Bundle manifest drives the installer contents
The desktop installer SHALL include exactly the resolved component set: deselected components SHALL NOT appear in `extraResources` (no `openconnector/`, `python/`, `litellm/`, or `postgres/` payload), and the bundled-resource build (`predist`) SHALL skip building deselected components. `resources/node/` SHALL always be built and bundled (the backend always requires it).

#### Scenario: lean installer excludes litellm payload
- **WHEN** the manifest excludes litellm (and postgres resolves excluded)
- **THEN** `predist` does not build `resources/python`, `resources/litellm`, or `resources/postgres`
- **AND** the packed app contains no `python/`, `litellm/`, or `postgres/` resource directories
- **AND** the app launches with LiteLLM degraded (absent) rather than crashing

#### Scenario: default manifest matches today's bundle
- **WHEN** the manifest selects all components
- **THEN** `predist` builds all current resources
- **AND** the packed app contains `node/`, `openconnector/`, `python/`, `litellm/`, and `postgres/` resource directories
