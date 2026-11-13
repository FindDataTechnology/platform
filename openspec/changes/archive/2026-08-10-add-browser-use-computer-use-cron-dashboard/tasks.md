## 1. Dependencies & Configuration

- [ ] 1.1 Add `node-schedule` to package.json dependencies
- [ ] 1.2 Update `mcp.example.json` with Playwright MCP server configuration
- [ ] 1.3 Document new env vars (ENABLE_COMPUTER_USE, CRON_STORAGE_PATH, BROWSER_HEADLESS_MODE)

## 2. Cron Module Implementation

- [ ] 2.1 Create `cron.js` module with job scheduling core
- [ ] 2.2 Implement JSON persistence with atomic writes
- [ ] 2.3 Add job management functions (add, remove, pause, resume, list)
- [ ] 2.4 Implement startup job restoration from storage
- [ ] 2.5 Add WebSocket event broadcasting for cron events
- [ ] 2.6 Implement execution queue with concurrency control
- [ ] 2.7 Add job history tracking with auto-pruning

## 3. Computer-Use Skills

- [ ] 3.1 Create `skills/computer-file-system/SKILL.md`
- [ ] 3.2 Create `skills/computer-process/SKILL.md`
- [ ] 3.3 Create `skills/computer-shell/SKILL.md`
- [ ] 3.4 Add ENABLE_COMPUTER_USE flag filtering in server.js
- [ ] 3.5 Verify skills load correctly when enabled

## 4. Server Integration

- [ ] 4.1 Import and initialize cron module in server.js
- [ ] 4.2 Add WebSocket message handlers for cron_* messages
- [ ] 4.3 Implement `dashboard_update` event with throttling
- [ ] 4.4 Send initial dashboard state on client connection
- [ ] 4.5 Register browser tools via MCP bridge (auto-discovered from mcp.json)
- [ ] 4.6 Add graceful shutdown for browser instances

## 5. Frontend Dashboard UI

- [ ] 5.1 Add Dashboard tab to sidebar navigation in app.js
- [ ] 5.2 Implement dashboard tab content area and state management
- [ ] 5.3 Add agent status card component
- [ ] 5.4 Add active tasks list component
- [ ] 5.5 Add scheduled jobs table with controls (pause/resume/delete/run-now)
- [ ] 5.6 Add recent activity log component
- [ ] 5.7 Add cron job creation form
- [ ] 5.8 Implement WebSocket event handlers for cron_* events
- [ ] 5.9 Implement `dashboard_update` event handler

## 6. Browser Tool Rendering

- [ ] 6.1 Add inline image rendering for screenshot tool results
- [ ] 6.2 Verify browser tool calls render as collapsible blocks
- [ ] 6.3 Test screenshot display in tool blocks

## 7. Testing & Verification

- [ ] 7.1 Test cron job creation, persistence, and execution
- [ ] 7.2 Test cron job restoration on server restart
- [ ] 7.3 Test computer-use skills invocation and tool execution
- [ ] 7.4 Test dashboard real-time updates
- [ ] 7.5 Verify graceful degradation when Playwright not configured
- [ ] 7.6 Verify computer skills are hidden when ENABLE_COMPUTER_USE is false
