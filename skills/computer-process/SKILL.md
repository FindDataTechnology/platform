---
name: computer-process
description: Process management - list running processes, check status, terminate processes
---

# Computer Process Management Skill

Use this skill to manage and inspect running processes on the local machine.

## Usage

Invoke with: `/skill:computer-process <operation> [arguments]`

### Operations

1. **List running processes**
   `/skill:computer-process list`

2. **Check process status by PID**
   `/skill:computer-process status <pid>`

3. **Terminate a process** (SIGTERM)
   `/skill:computer-process kill <pid>`

4. **Force terminate a process** (SIGKILL)
   `/skill:computer-process kill-force <pid>`

## Notes

- Process IDs are system-specific
- Terminating processes may affect system stability - use with caution
- Permission restrictions apply based on the server's user context
