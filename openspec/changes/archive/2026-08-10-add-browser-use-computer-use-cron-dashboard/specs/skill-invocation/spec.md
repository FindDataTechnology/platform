# skill-invocation Specification Delta

## ADDED Requirements

### Requirement: Computer-use skills respect ENABLE_COMPUTER_USE flag
The server SHALL filter computer-use skills from the skills list unless `ENABLE_COMPUTER_USE=true` is set in the environment.

#### Scenario: Computer skills filtered when disabled
- **WHEN** `ENABLE_COMPUTER_USE` is not set or set to `false`
- **THEN** the server SHALL exclude computer-use skills from the `skills` response
- **AND** SHALL NOT expand `/skill:computer-*` invocations

### Requirement: Computer skill tool calls render nested
Tool calls triggered by computer-use skill invocations SHALL render nested under the skill block in the chat UI.

#### Scenario: Tool calls nested under skill block
- **WHEN** a computer-use skill invocation triggers MCP tool calls
- **THEN** each tool block SHALL render indented under the skill block
- **AND** SHALL maintain independent collapsibility
