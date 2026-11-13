## MODIFIED Requirements

### Requirement: Server loads skills from configured paths

The server SHALL configure the dsh runtime (via the profile/bundle) with a skill plugin / skill-paths entry pointing at a local skills directory so that skills are loaded into the agent's system prompt and slash-command table at startup, replacing the pi `additionalSkillPaths` resource-loader mechanism. The server SHALL also load custom skill definitions from the SQLite database (if present) and register them alongside file-based skills.

#### Scenario: skills are loaded at startup

- **WHEN** the skills directory contains one or more `SKILL.md` files
- **THEN** the dsh runtime SHALL discover and load those skills via its skill plugin
- **AND** the loaded skills SHALL be available to the agent session

#### Scenario: no skills directory

- **WHEN** the configured skills directory is empty or absent
- **THEN** the server SHALL start normally with no skills loaded

#### Scenario: database custom skills are loaded

- **WHEN** the SQLite database contains custom skill definitions
- **THEN** the server SHALL load those skills and register them alongside file-based skills
- **AND** database skills SHALL be available to the agent session

### Requirement: Server lists available skills to the client

The server SHALL respond to a `list_skills` WebSocket message with the set of currently loaded skills, each including its name, description, source (file or database), and enabled status. The skill list SHALL be sourced from the dsh runtime's reported skills over the JSON-RPC bridge.

#### Scenario: client requests the skill list

- **WHEN** a WebSocket client sends `{ "type": "list_skills" }`
- **THEN** the server SHALL reply with `{ "type": "skills", "skills": [ { "name": "...", "description": "...", "source": "file|database", "enabled": true|false }, ... ] }`

### Requirement: User can invoke skills via slash-command syntax

The server SHALL accept prompts whose first token begins with `/skill:` as skill invocations, forwarding them to the dsh runtime for expansion, and SHALL broadcast a `skill_use` event to all clients before forwarding. Only enabled skills SHALL be invokable; attempts to invoke disabled skills SHALL return an error.

#### Scenario: user invokes a skill

- **WHEN** a client sends `{ "type": "prompt", "text": "/skill:graphify some input" }`
- **THEN** the server SHALL broadcast `{ "type": "skill_use", "name": "graphify", "args": "some input" }` to all clients
- **AND** SHALL forward the text to the dsh runtime for expansion

#### Scenario: skill expansion falls back to manual lookup

- **WHEN** the dsh runtime does not expand a `/skill:` token
- **THEN** the server SHALL look up the skill content from the loaded skills and prepend it to the prompt before forwarding

#### Scenario: user invokes a disabled skill

- **WHEN** a client sends a prompt invoking a skill that is currently disabled
- **THEN** the server SHALL return an error to the client and SHALL NOT forward the prompt to the dsh runtime
