## Context

The Platform currently manages MCP servers and skills through file-based configuration:
- MCP servers: declared in `mcp.json`, connected at startup via `mcp-bridge.js`
- Skills: `SKILL.md` files in `skills/` directory, loaded at startup via `additionalSkillPaths`

Both are static — changes require editing files and restarting the server. The React frontend has no visibility into what's configured, let alone the ability to manage it.

The platform's architecture already supports runtime extensibility (the pi agent session accepts tools dynamically, skills are loaded from a directory), but there's no API or UI to exercise that capability.

**Stakeholders**: End users who want to extend the platform without editing config files; developers who want a clearer extension management story.

## Goals / Non-Goals

**Goals:**
- Provide a React UI page to view, add, remove, enable/disable MCP servers and skills
- Provide a curated marketplace catalog for one-click installation of popular extensions
- Support runtime changes — adding/removing an MCP server or skill takes effect immediately without server restart
- Persist extension configs in SQLite so they survive restarts
- Maintain backward compatibility — existing `mcp.json` and `skills/` directory continue to work

**Non-Goals:**
- Building a full extension registry/marketplace service (the catalog is static JSON shipped with the app or fetched from a configurable URL)
- Supporting arbitrary skill installation from git repos or npm packages (market catalog entries are pre-vetted)
- Per-user extension isolation (extensions are global to the platform instance)
- Version management or update checking for installed extensions

## Decisions

### 1. Persistence: SQLite over file-based config

**Decision**: Store MCP server configs and custom skill definitions in SQLite tables, not in `mcp.json` / `skills/` files.

**Rationale**:
- SQLite is already in use (chat history, documents, preferences) — no new persistence mechanism
- Atomic writes, transactional integrity, no file-locking issues
- Easier to query (list enabled servers, check if a server exists)
- `mcp.json` and `skills/` remain as fallback/legacy — on startup, if SQLite tables are empty, import from files

**Alternatives considered**:
- Write back to `mcp.json` / `skills/` — simpler but file I/O on every change, no atomic updates, harder to query
- External database (Postgres) — overkill for a single-user desktop app

### 2. Hot-reload: Reconnect MCP clients, re-register skills

**Decision**: When an MCP server is added/removed/enabled/disabled, call `connectServer()` or `disconnectServer()` on the bridge; when a skill is added/removed, re-scan the skills directory and update the agent's tool allowlist.

**Rationale**:
- `mcp-bridge.js` already has `connectServer()` — add a `disconnectServer()` method
- The pi agent session's tool allowlist is an array passed at creation — we need to make it mutable or recreate the session (recreation is simpler, loses no state since the session is stateless between prompts)
- Skills are loaded from disk at startup — add a `reloadSkills()` method that re-scans and updates the resource loader

**Alternatives considered**:
- Restart the server on config change — simpler but loses WebSocket connections, chat state
- Make the tool allowlist dynamic — requires changes to the pi SDK (out of scope)

### 3. Market catalog: Static JSON over dynamic registry

**Decision**: Ship a `market-catalog.json` file with the app (or fetch from a configurable URL) containing a curated list of MCP servers and skills with metadata (name, description, category, install config).

**Rationale**:
- No need to build a registry service — the catalog is small (<100 entries), curated by the platform team
- Static JSON is easy to update (PR to the repo, or fetch from a URL)
- One-click install = parse the catalog entry, write to SQLite, trigger hot-reload

**Alternatives considered**:
- Dynamic registry (like npm) — overkill, requires auth, versioning, publishing flow
- Hardcoded catalog in React — harder to update without rebuilding the app

### 4. UI location: `/settings/extensions` route

**Decision**: Add a new route `/settings/extensions` with two tabs: **Installed** and **Market**. Add a "Settings" or "Extensions" link in the sidebar.

**Rationale**:
- Keeps the main chat UI clean — extension management is a settings/admin task
- Tabbed interface separates "what I have" from "what I can get"
- Follows the pattern of other management pages (Documents, Dashboard)

**Alternatives considered**:
- Modal dialog — too cramped for browsing a catalog
- Separate routes for Installed vs Market — more clicks, harder to compare

### 5. Enable/disable state: Per-extension flag in SQLite

**Decision**: Each MCP server and skill has an `enabled` boolean in SQLite. Disabled servers are not connected; disabled skills are not loaded. The config remains in the DB so re-enabling is instant.

**Rationale**:
- Preserves user's config — they can disable a server temporarily without losing its settings
- Simpler than delete/re-add
- Matches the pattern of other platforms (browser extensions, VS Code extensions)

**Alternatives considered**:
- Delete to disable — loses config, harder to re-enable
- Separate "disabled" table — more complex schema, no benefit

## Risks / Trade-offs

**[Risk] Hot-reload breaks the agent session** → Mitigation: The agent session is stateless between prompts — recreating it on config change loses no user-visible state. Test thoroughly with in-flight prompts (should be rare since config changes are admin actions).

**[Risk] Market catalog becomes stale** → Mitigation: Fetch from a configurable URL (default to a GitHub raw URL) with a fallback to the shipped JSON. Add a "refresh" button in the UI.

**[Risk] SQLite migration breaks existing `mcp.json` setups** → Mitigation: On startup, if SQLite tables are empty, import from `mcp.json` and `skills/`. Log the migration. Keep the files as a backup (don't delete them).

**[Risk] MCP server install fails (bad config, network error)** → Mitigation: Validate config before writing to SQLite. On hot-reload, if `connectServer()` fails, roll back the DB write and show an error in the UI.

**[Trade-off] SQLite persistence vs file-based config** — SQLite is more robust but less human-readable. Users who prefer editing config files directly can still edit `mcp.json` / `skills/` — the startup import handles it.

**[Trade-off] Static market catalog vs dynamic registry** — Static is simpler but requires app updates or URL changes to refresh. Acceptable for v1; a dynamic registry can be added later if needed.
