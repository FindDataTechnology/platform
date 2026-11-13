## MODIFIED Requirements

### Requirement: Server loads skills from configured paths
The server SHALL configure the pi resource loader with `additionalSkillPaths` pointing at a local skills directory so that skills are loaded into the agent's system prompt and slash-command table at startup. The server SHALL also load custom skill definitions from the SQLite database (if present) and register them alongside file-based skills.

#### Scenario: skills are loaded at startup
- **WHEN** the skills directory contains one or more `SKILL.md` files
- **THEN** the resource loader SHALL discover and load those skills
- **AND** the loaded skills SHALL be available to the agent session

#### Scenario: no skills directory
- **WHEN** the configured skills directory is empty or absent
- **THEN** the server SHALL start normally with no skills loaded

#### Scenario: database custom skills are loaded
- **WHEN** the SQLite database contains custom skill definitions
- **THEN** the server SHALL load those skills and register them alongside file-based skills
- **AND** database skills SHALL be available to the agent session

### Requirement: Server lists available skills to the client
The server SHALL respond to a `list_skills` WebSocket message with the set of currently loaded skills, each including its name, description, source (file or database), and enabled status.

#### Scenario: client requests the skill list
- **WHEN** a WebSocket client sends `{ "type": "list_skills" }`
- **THEN** the server SHALL reply with `{ "type": "skills", "skills": [ { "name": "...", "description": "...", "source": "file|database", "enabled": true|false }, ... ] }`

### Requirement: User can invoke skills via slash-command syntax
The server SHALL accept prompts whose first token begins with `/skill:` as skill invocations, forwarding them to the agent session for expansion, and SHALL broadcast a `skill_use` event to all clients before forwarding. Only enabled skills SHALL be invokable; attempts to invoke disabled skills SHALL return an error.

#### Scenario: user invokes a skill
- **WHEN** a client sends `{ "type": "prompt", "text": "/skill:graphify some input" }`
- **THEN** the server SHALL broadcast `{ "type": "skill_use", "name": "graphify", "args": "some input" }` to all clients
- **AND** SHALL forward the text to `session.prompt()` for expansion

#### Scenario: skill expansion falls back to manual lookup
- **WHEN** the agent session does not expand a `/skill:` token
- **THEN** the server SHALL look up the skill content from the loaded skills and prepend it to the prompt before forwarding

#### Scenario: user invokes a disabled skill
- **WHEN** a client sends a prompt invoking a skill that is currently disabled
- **THEN** the server SHALL return an error to the client and SHALL NOT forward the prompt to the agent

### Requirement: Skill invocations render as collapsible blocks
The chat UI SHALL render each `skill_use` event as a collapsible block showing the skill name in its header and the invocation arguments in its body, in place of echoing the raw `/skill:...` text as a user message.

#### Scenario: skill invocation displayed
- **WHEN** the server sends a `skill_use` event for skill `graphify`
- **THEN** the UI SHALL render a collapsible block with header `Skill: graphify`
- **AND** the body SHALL show the invocation arguments
- **AND** the raw `/skill:graphify ...` text SHALL NOT be rendered as a normal user message

### Requirement: Chat input provides slash-command autocomplete
The chat UI SHALL present a slash-command autocomplete popup (specified by the `chat-commands` capability) that includes the available `/skill:<name>` commands alongside the meta-commands (`/model`, `/new`, `/clear`, `/help`), filtered by the text typed after `/`. Skill commands in the popup SHALL be sourced from the `skills` list and SHALL only include enabled skills. The user SHALL be able to navigate the list with arrow keys and insert the selected command with Enter; Escape SHALL close the popup without inserting. Inserting a command SHALL NOT auto-send; the user may append arguments and send normally.

#### Scenario: skills appear in the unified command list
- **WHEN** the user types `/` at the start of the chat input
- **THEN** the popup SHALL list the available `/skill:` commands (only enabled skills) alongside the meta-commands

#### Scenario: filtering skills by typed text
- **WHEN** the user types `/gra` in the chat input
- **THEN** the popup SHALL list only the commands (including enabled skills) whose names match `gra`
