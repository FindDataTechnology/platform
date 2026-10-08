# bundle-manifest Specification

## Purpose
Defines the `platform.bundle.json` manifest that governs which extensions (MCP servers, skills) and their permissions are bundled into a build, and how bundled extensions are seeded into the runtime on first run.

## Requirements

### Requirement: Bundle manifest file format
The system SHALL read an optional `platform.bundle.json` at the project root declaring: `mcpServers` (name -> MCP config + `enabled`), `skills` (array of skill names under `skills/`), and `permissions` (`mcp:<name>` / `skill:<name>` -> `{ allow, deny, locked }`). A missing manifest SHALL resolve to the default: no bundled MCP servers, no bundled skills, no permissions. An invalid manifest (unparseable JSON, unknown top-level key) SHALL fail the build scripts and SHALL cause the runtime to log a clear error and fall back to the default resolution.

#### Scenario: manifest declares bundled extensions
- **WHEN** `platform.bundle.json` declares an `mcpServers` entry and a `skills` entry
- **THEN** bundle resolution reports those MCP servers and skills as bundled, with their declared permissions

#### Scenario: missing manifest resolves to defaults
- **WHEN** no `platform.bundle.json` exists
- **THEN** resolution reports empty `mcpServers`, `skills`, and `permissions`

#### Scenario: invalid manifest falls back with an error
- **WHEN** `platform.bundle.json` contains unparseable JSON
- **THEN** build scripts SHALL fail with a clear validation error
- **AND** the runtime logs the error and resolves the default (no bundled extensions)

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
