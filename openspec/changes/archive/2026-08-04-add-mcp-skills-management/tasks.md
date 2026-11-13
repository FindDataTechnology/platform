## 1. Database Schema & Persistence

- [x] 1.1 Create `extension_configs` table in SQLite for MCP server configurations (id, name, type, config_json, enabled, created_at, updated_at)
- [x] 1.2 Create `custom_skills` table in SQLite for custom skill definitions (id, name, description, content, enabled, created_at, updated_at)
- [x] 1.3 Implement `extension-store.js` module with CRUD operations for MCP server configs (list, get, add, update, remove, enable/disable)
- [x] 1.4 Implement `extension-store.js` module with CRUD operations for custom skills (list, get, add, update, remove, enable/disable)
- [x] 1.5 Add database migration to create the new tables on startup

## 2. Backend API Routes

- [x] 2.1 Implement `GET /api/extensions/mcp` to list all MCP server configurations (from mcp.json + database)
- [x] 2.2 Implement `POST /api/extensions/mcp` to add a new MCP server configuration (persist to database)
- [x] 2.3 Implement `PUT /api/extensions/mcp/:name` to update an MCP server configuration
- [x] 2.4 Implement `DELETE /api/extensions/mcp/:name` to remove an MCP server configuration
- [x] 2.5 Implement `PATCH /api/extensions/mcp/:name/enable` to enable/disable an MCP server
- [x] 2.6 Implement `GET /api/extensions/skills` to list all skills (file-based + database custom skills)
- [x] 2.7 Implement `POST /api/extensions/skills` to add a new custom skill (persist to database)
- [x] 2.8 Implement `PUT /api/extensions/skills/:name` to update a custom skill
- [x] 2.9 Implement `DELETE /api/extensions/skills/:name` to remove a custom skill
- [x] 2.10 Implement `PATCH /api/extensions/skills/:name/enable` to enable/disable a skill
- [x] 2.11 Implement `GET /api/extensions/market` to return the curated market catalog (MCP servers + skills)

## 3. Runtime Management (Hot-Reload)

- [x] 3.1 Extend `mcp-bridge.js` with `connectServer(name, config)` method for runtime connections
- [x] 3.2 Extend `mcp-bridge.js` with `disconnectServer(name)` method for runtime disconnections
- [x] 3.3 Extend `mcp-bridge.js` with `reconnectServer(name, config)` method for runtime updates
- [x] 3.4 Implement tool registry update logic in `server.js` to add/remove tools when MCP servers change
- [x] 3.5 Extend skill loader in `server.js` with `registerSkill(skill)` method for runtime skill registration
- [x] 3.6 Extend skill loader in `server.js` with `unregisterSkill(name)` method for runtime skill removal
- [x] 3.7 Wire API routes to call runtime management methods and broadcast WebSocket events on changes
- [x] 3.8 Add WebSocket event `extensions_changed` to notify clients when MCP servers or skills change

## 4. Market Catalog

- [x] 4.1 Create `market-catalog.json` with curated list of popular MCP servers (name, description, category, config template, install instructions)
- [x] 4.2 Add popular MCP servers to catalog: filesystem, github, postgres, sqlite, puppeteer, memory, sequential-thinking
- [x] 4.3 Create `market-catalog-skills.json` with curated list of popular skills (name, description, category, skill template)
- [x] 4.4 Add popular skills to catalog: code-review, debug-helper, refactor, test-generator, doc-writer
- [x] 4.5 Implement market catalog loader in `extension-store.js` to read and serve the catalog files

## 5. Frontend - Page Structure & Routing

- [x] 5.1 Create `web/src/pages/ExtensionsPage.tsx` with tabbed layout (Installed / Market)
- [x] 5.2 Add route `/extensions` to `web/src/App.tsx` pointing to ExtensionsPage
- [x] 5.3 Add "Extensions" link to sidebar navigation in `web/src/components/Sidebar.tsx`
- [x] 5.4 Create `InstalledTab.tsx` component with two sections: MCP Servers and Skills
- [x] 5.5 Create `MarketTab.tsx` component with two sections: MCP Servers and Skills catalogs

## 6. Frontend - Installed Tab Components

- [x] 6.1 Create `McpServerList.tsx` component to display list of configured MCP servers
- [x] 6.2 Create `McpServerCard.tsx` component with name, description, status badge, enable/disable toggle, edit/delete buttons
- [x] 6.3 Create `McpServerForm.tsx` modal/dialog for adding/editing MCP server configurations (name, type, command/args/env for stdio or URL/headers for HTTP)
- [x] 6.4 Create `SkillList.tsx` component to display list of all skills (file-based + custom)
- [x] 6.5 Create `SkillCard.tsx` component with name, description, source badge (file/database), enable/disable toggle, edit/delete buttons (edit/delete only for custom skills)
- [x] 6.6 Create `SkillForm.tsx` modal/dialog for adding/editing custom skills (name, description, content markdown editor)

## 7. Frontend - Market Tab Components

- [x] 7.1 Create `McpMarketList.tsx` component to display catalog of available MCP servers
- [x] 7.2 Create `McpMarketCard.tsx` component with name, description, category, install button
- [x] 7.3 Create `SkillMarketList.tsx` component to display catalog of available skills
- [x] 7.4 Create `SkillMarketCard.tsx` component with name, description, category, install button
- [x] 7.5 Implement install flow: clicking "Install" opens pre-filled add form with config from catalog

## 8. Frontend - State Management & API Client

- [x] 8.1 Create `web/src/hooks/useExtensionsStore.ts` Zustand store for extension state (mcp servers, skills, market catalog, loading states)
- [x] 8.2 Create `web/src/lib/extensions-api.ts` API client with methods for all `/api/extensions/*` endpoints
- [x] 8.3 Implement store actions: fetchMcpServers, addMcpServer, updateMcpServer, removeMcpServer, toggleMcpServer
- [x] 8.4 Implement store actions: fetchSkills, addSkill, updateSkill, removeSkill, toggleSkill
- [x] 8.5 Implement store actions: fetchMarketCatalog
- [x] 8.6 Add WebSocket listener for `extensions_changed` event to refresh store state
- [x] 8.7 Add i18n translations for Extensions page (en, zh-CN, ja, fr, es)

## 9. Integration & Testing

- [x] 9.1 Test adding/removing MCP servers via UI and verify they connect/disconnect
- [x] 9.2 Test enabling/disabling MCP servers and verify tools are registered/unregistered
- [x] 9.3 Test adding/removing custom skills via UI and verify they appear in slash-command autocomplete
- [x] 9.4 Test enabling/disabling skills and verify they can/cannot be invoked
- [x] 9.5 Test installing MCP servers from market catalog and verify configuration is created
- [x] 9.6 Test installing skills from market catalog and verify skill is registered
- [x] 9.7 Verify persistence: restart server and confirm MCP servers and custom skills are reloaded
- [x] 9.8 Verify backward compatibility: existing `mcp.json` and `skills/` files still work
