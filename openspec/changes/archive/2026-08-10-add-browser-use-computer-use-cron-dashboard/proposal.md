## Why

The current platform lacks automation capabilities for browser interaction, computer control, scheduled task execution, and system monitoring. Adding these features will enable the coding agent to perform automated testing, UI interactions, scheduled operations, and provide visibility into system status - significantly expanding its practical utility for real-world development workflows.

## What Changes

- Add browser automation MCP tools (Playwright-based) for web interaction and testing
- Add computer use skills for system-level operations (file management, process control)
- Add cron/scheduling module for timed and recurring task execution
- Add dashboard UI for monitoring agent status, scheduled tasks, and system metrics

## Capabilities

### New Capabilities

- `browser-use-tools`: Browser automation and web interaction tools (navigation, screenshots, form filling, element extraction)
- `computer-use-skills`: Computer/OS-level operations including file system access, process management, and shell execution
- `cron-module`: Scheduled and recurring task execution with cron-style scheduling, task persistence, and status tracking
- `dashboard`: System dashboard UI showing agent status, active tasks, scheduled jobs, and activity history

### Modified Capabilities

- `chat-streaming`: Add dashboard-related event types for real-time status updates
- `tool-use-rendering`: Extend to support browser and computer-use tool visualization
- `skill-invocation`: Add computer-use skill invocation patterns

## Impact

- New files: `browser-use.js`, `computer-use.js`, `cron.js`, dashboard components in `public/`
- Modified: `server.js` (register new tools/skills), `public/app.js` (dashboard UI, new event types)
- New dependencies: Playwright (for browser automation), cron-parser or node-schedule (for scheduling)
- New env vars: CRON_STORAGE_PATH, BROWSER_HEADLESS_MODE
- New WS event types: `cron_status`, `dashboard_update`, `browser_event`
