---
name: computer-shell
description: Shell command execution - run commands, scripts, and system operations
---

# Computer Shell Execution Skill

Use this skill to execute shell commands and scripts on the local machine.

## Usage

Invoke with: `/skill:computer-shell <operation> [arguments]`

### Operations

1. **Execute a shell command**
   `/skill:computer-shell exec "ls -la"`

2. **Execute with timeout** (in seconds, default 30)
   `/skill:computer-shell exec "long-running-command" --timeout 60`

3. **Execute in specific directory**
   `/skill:computer-shell exec "npm install" --cwd /path/to/project`

## Notes

- Commands run with the server's user permissions
- Long-running commands may timeout (default: 30 seconds)
- Output is captured and returned as text
- Use with caution - shell commands can modify the system
