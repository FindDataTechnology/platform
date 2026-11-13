# computer-use-skills Specification

## Purpose
Defines computer/OS-level operation skills that enable the agent to perform file system operations, process management, and shell execution, following the existing skill-invocation pattern.

## ADDED Requirements

### Requirement: Computer-use skills are loaded from skills directory
The server SHALL load computer-use skills from the `skills/` directory, including `computer-file-system`, `computer-process`, and `computer-shell` skills. If `ENABLE_COMPUTER_USE` env var is not set to `true`, the skills SHALL be excluded from the available skills list.

#### Scenario: Computer skills enabled
- **WHEN** `ENABLE_COMPUTER_USE=true` is set in the environment
- **THEN** computer-use skills SHALL appear in the `list_skills` response
- **AND** SHALL be available for invocation via `/skill:computer-*`

#### Scenario: Computer skills disabled by default
- **WHEN** `ENABLE_COMPUTER_USE` is not set or set to `false`
- **THEN** computer-use skills SHALL NOT appear in the skills list
- **AND** SHALL NOT be available for invocation

### Requirement: File system skill provides core file operations
The `computer-file-system` skill SHALL enable the agent to list directory contents, read files, write files, create directories, and delete files.

#### Scenario: List directory contents
- **WHEN** the user invokes `/skill:computer-file-system list /path/to/dir`
- **THEN** the skill SHALL expand to instructions for listing the directory
- **AND** the agent SHALL execute the appropriate MCP tool to get directory contents

#### Scenario: Read file content
- **WHEN** the user invokes `/skill:computer-file-system read /path/to/file`
- **THEN** the skill SHALL expand to instructions for reading the file
- **AND** the agent SHALL return the file content

#### Scenario: Write file
- **WHEN** the user invokes `/skill:computer-file-system write /path/to/file "content"`
- **THEN** the skill SHALL expand to instructions for writing the file
- **AND** the agent SHALL create or overwrite the file with the provided content

### Requirement: Process skill provides process management
The `computer-process` skill SHALL enable the agent to list running processes, check process status, and terminate processes.

#### Scenario: List running processes
- **WHEN** the user invokes `/skill:computer-process list`
- **THEN** the skill SHALL expand to instructions for listing processes
- **AND** the agent SHALL return a list of running processes with PID and name

#### Scenario: Terminate process
- **WHEN** the user invokes `/skill:computer-process kill <pid>`
- **THEN** the skill SHALL expand to instructions for terminating the process
- **AND** the agent SHALL terminate the specified process

### Requirement: Shell skill provides command execution
The `computer-shell` skill SHALL enable the agent to execute shell commands with configurable timeout and working directory.

#### Scenario: Execute shell command
- **WHEN** the user invokes `/skill:computer-shell exec "ls -la"`
- **THEN** the skill SHALL expand to instructions for executing the command
- **AND** the agent SHALL return the command stdout and stderr

#### Scenario: Execute command with timeout
- **WHEN** the user invokes `/skill:computer-shell exec "long-command" --timeout 30`
- **THEN** the skill SHALL expand to instructions with the specified timeout
- **AND** the command SHALL be terminated after the timeout if still running

### Requirement: Computer skill invocations render in chat UI
Computer-use skill invocations SHALL render as collapsible blocks in the chat UI, showing the skill name, arguments, and any resulting tool calls.

#### Scenario: Computer skill invocation displayed
- **WHEN** the server sends a `skill_use` event for `computer-file-system`
- **THEN** the UI SHALL render a collapsible block with header `Skill: Computer File System`
- **AND** the body SHALL show the invocation arguments

#### Scenario: Resulting tool calls nested under skill
- **WHEN** a computer skill invocation triggers subsequent MCP tool calls
- **THEN** those tool blocks SHALL render nested under the skill block
- **AND** SHALL be collapsible independently
