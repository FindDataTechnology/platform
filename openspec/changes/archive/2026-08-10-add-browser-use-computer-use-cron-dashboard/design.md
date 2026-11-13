## Context

This change adds four major capabilities to the PAAS platform: browser automation tools, computer/OS-level skills, cron-based scheduling, and a dashboard UI. The current platform is a vanilla-JS Express + WebSocket server with a pi coding agent backend. All new capabilities follow the existing patterns for graceful degradation, event-driven UI, and server-side credential management.

## Goals / Non-Goals

**Goals:**
- Add Playwright-based browser automation tools as MCP-wrapped tools
- Add computer-use skills for file system, process, and shell operations
- Implement a cron scheduling module for recurring agent tasks
- Add a dashboard UI for monitoring agent status and scheduled tasks
- All new features follow existing patterns (event-driven WS, graceful degradation, atomic persistence)

**Non-Goals:**
- No distributed cron (single-server, in-memory with persistence)
- No cross-browser support (Chromium only via Playwright)
- No permission granularity beyond existing server-side controls
- No user authentication for dashboard (single-user model per server instance)

## Decisions

### Browser Automation: Playwright MCP Server
- **Decision**: Use Playwright MCP server (`@playwright/mcp`) via existing MCP bridge
- **Rationale**: Playwright is industry standard, MCP server is maintained, integrates with existing `mcp-bridge.js` without new code. No need to write custom tool wrappers.
- **Alternatives considered**:
  - Custom Playwright tool wrappers: Would duplicate existing MCP functionality
  - Puppeteer: Smaller ecosystem, less maintained MCP integration
- **Configuration**: Add to `mcp.json` as optional server; logs warning and skips if Playwright browser not installed

### Computer-Use Skills: Local Skill Files
- **Decision**: Implement as local `skills/` markdown files with frontmatter, using existing skill loading mechanism
- **Rationale**: Leverages existing `skill-invocation` capability, zero new backend code needed. Skills can call existing `bash`/`fs` MCP tools.
- **Skills created**: `computer-file-system`, `computer-process`, `computer-shell`
- **Security**: Tools already restricted by MCP server configuration; no new trust boundaries

### Cron Module: node-schedule + JSON Persistence
- **Decision**: Use `node-schedule` for scheduling with simple JSON file persistence
- **Rationale**: Lightweight, no database dependency, matches existing document persistence pattern (atomic temp-file + rename).
- **Alternatives considered**:
  - `node-cron`: Less feature-rich (no one-shot jobs)
  - `bullmq`: Requires Redis, overkill for single-server use case
- **Storage**: `cron-store/jobs.json` with atomic writes. In-memory schedule rebuilt from file on startup.
- **WS Events**: `cron_status` (job added/removed/triggered), `dashboard_update` for live status

### Dashboard: Tab Extension in Existing Frontend
- **Decision**: Add Dashboard as a new sidebar tab alongside Chat/Chat History/Documents/OpenConnector
- **Rationale**: Uses existing app.js UI patterns (tab switching, WebSocket event handling), no new framework, minimal new code.
- **Dashboard sections**: Agent status card, active tasks list, scheduled jobs table, recent activity log
- **WS Events**: Reuses existing events + new `dashboard_update` aggregate event

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Browser automation consumes significant memory | Headless mode by default, max concurrent browser limit (1), auto-close after 5min idle |
| Cron jobs can cause concurrent agent runs | Job queue with concurrency limit (1), skip overlapping runs |
| Computer-use skills have security implications | Disabled by default, explicit env var `ENABLE_COMPUTER_USE=true` required, commands logged |
| Large cron job history causes memory bloat | Auto-prune jobs older than 7 days, max 100 jobs stored |
| Dashboard UI adds app.js complexity | Lazy-load dashboard components, re-use existing collapsible block patterns |

## Migration Plan

1. Add dependencies to package.json (`node-schedule`, `playwright` optional)
2. Create new modules: `cron.js`, dashboard components in `public/`
3. Modify `server.js` to register new modules and WS handlers
4. Add computer-use skill files to `skills/`
5. Update `mcp.example.json` with Playwright MCP server config
6. Document new env vars in README

**Rollback**: Remove new modules, revert server.js changes, remove skill files

## Open Questions

- What specific browser actions should be prioritized? (navigate, screenshot, fill form, click - baseline set)
- Should cron jobs persist across server restarts? (Yes, per JSON persistence decision)
- What dashboard metrics are most valuable? (Start with agent status, scheduled jobs, recent activity - expand based on usage)
