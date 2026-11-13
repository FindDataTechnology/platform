## ADDED Requirements

### Requirement: Server loads skills from configured paths
The server SHALL configure the pi resource loader with `additionalSkillPaths` pointing at a local skills directory so that skills are loaded into the agent's system prompt and slash-command table at startup.

#### Scenario: skills are loaded at startup
- **WHEN** the skills directory contains one or more `SKILL.md` files
- **THEN** the resource loader SHALL discover and load those skills
- **AND** the loaded skills SHALL be available to the agent session

#### Scenario: no skills directory
- **WHEN** the configured skills directory is empty or absent
- **THEN** the server SHALL start normally with no skills loaded

### Requirement: Server lists available skills to the client
The server SHALL respond to a `list_skills` WebSocket message with the set of currently loaded skills, each including its name and description.

#### Scenario: client requests the skill list
- **WHEN** a WebSocket client sends `{ "type": "list_skills" }`
- **THEN** the server SHALL reply with `{ "type": "skills", "skills": [ { "name": "...", "description": "..." }, ... ] }`

### Requirement: User can invoke skills via slash-command syntax
The server SHALL accept prompts whose first token begins with `/skill:` as skill invocations, forwarding them to the agent session for expansion, and SHALL broadcast a `skill_use` event to all clients before forwarding.

#### Scenario: user invokes a skill
- **WHEN** a client sends `{ "type": "prompt", "text": "/skill:graphify some input" }`
- **THEN** the server SHALL broadcast `{ "type": "skill_use", "name": "graphify", "args": "some input" }` to all clients
- **AND** SHALL forward the text to `session.prompt()` for expansion

#### Scenario: skill expansion falls back to manual lookup
- **WHEN** the agent session does not expand a `/skill:` token
- **THEN** the server SHALL look up the skill content from the loaded skills and prepend it to the prompt before forwarding

### Requirement: Skill invocations render as collapsible blocks
The chat UI SHALL render each `skill_use` event as a collapsible block showing the skill name in its header and the invocation arguments in its body, in place of echoing the raw `/skill:...` text as a user message.

#### Scenario: skill invocation displayed
- **WHEN** the server sends a `skill_use` event for skill `graphify`
- **THEN** the UI SHALL render a collapsible block with header `Skill: graphify`
- **AND** the body SHALL show the invocation arguments
- **AND** the raw `/skill:graphify ...` text SHALL NOT be rendered as a normal user message
