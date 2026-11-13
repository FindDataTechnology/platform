## Why

MCP servers and skills are currently configured by hand-editing `mcp.json` and dropping `SKILL.md` files into `skills/`. This works for developers but creates friction for end users who want to extend the platform with new capabilities. A management UI with a curated marketplace lowers the barrier to discovery and installation, making the platform's extensibility accessible without touching config files.

## What Changes

- Add a new React page at `/settings/extensions` (or similar route) with two tabs: **Installed** and **Market**
- **Installed tab**: list all configured MCP servers and skills with metadata (name, description, status), enable/disable toggles, and add/remove/configure actions
- **Market tab**: curated catalog of popular MCP servers and skills, browsable by category, installable with one click (generates config entries automatically)
- Backend API routes to manage MCP server configs and skill definitions at runtime (persisted to SQLite or written back to `mcp.json` / `skills/`)
- Hot-reload MCP connections and skill registrations when configs change (no server restart required)
- Market catalog sourced from a static JSON file (shipped with the app) or fetched from a remote registry URL

## Capabilities

### New Capabilities
- `extension-management-ui`: React page for browsing, configuring, and managing MCP servers and skills with enable/disable toggles and CRUD operations
- `extension-marketplace`: Curated catalog of MCP servers and skills browsable by category, with one-click install that generates config entries
- `extension-runtime-management`: Backend API and hot-reload logic for adding/removing/enabling/disabling MCP servers and skills at runtime without server restart

### Modified Capabilities
- `mcp-integration`: Extend to support runtime config changes (add/remove servers) and per-server enable/disable state, not just startup-time loading from `mcp.json`
- `skill-invocation`: Extend to support runtime skill registration (add/remove custom skills) and per-skill enable/disable state, not just startup-time loading from disk

## Impact

- **Frontend**: New React page (`ExtensionsPage.tsx` or similar), new route, new Zustand store for extension state, new API client methods
- **Backend**: New REST API routes under `/api/extensions/*` for listing, adding, removing, enabling/disabling MCP servers and skills; hot-reload hooks in `mcp-bridge.js` and skill loader
- **Persistence**: MCP server configs and custom skills stored in SQLite (new tables) or written back to `mcp.json` / `skills/` directory; market catalog as static JSON or remote fetch
- **Dependencies**: No new npm packages required (existing React, Zustand, Express, better-sqlite3 cover it)
- **Existing code**: `mcp-bridge.js` gains connect/disconnect methods; skill loader gains register/unregister methods; `server.js` mounts new API routes and WebSocket events for extension state changes
