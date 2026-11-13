# agent-delegation-tools Delta

## MODIFIED Requirements

### Requirement: Delegation tools are available to all personas
Every persona preset SHALL have access to delegation tools — delegate, progress, result — exposed through the cell's local MCP configuration alongside the scheduling tools, plus the market-agent discovery tool `search_agents` (openspec: agent-delegation-a2a). The tools SHALL operate only on tasks of the cell they run in.

#### Scenario: Tool visible to a persona

- **WHEN** a persona lists its available tools
- **THEN** the four delegation tools (delegate, progress, result, search_agents) are present regardless of the active preset

### Requirement: Delegate creates a manual task bound to the target persona
The delegate tool SHALL create a task carrying a target naming the executor — `{type: "persona", ref}` for another persona of this cell, or `{type: "a2a", ref}` for a market Agent Service in the catalog (openspec: agent-delegation-a2a) — and the delegated prompt, executed immediately by the engine's serial policy (a2a targets execute as remote tasks under the same discipline). The tool SHALL return immediately with the task identifier, dedicated-session title, and queued state — it SHALL NOT wait for the execution. Fan-out is multiple delegate calls in one conversation turn, mixing target types freely. The self-delegation guard applies to persona targets only; an a2a target is always another agent by construction.

#### Scenario: Delegate lands as a queued task

- **WHEN** the persona calls delegate with target persona P and a prompt
- **THEN** a task is created with trigger `manual`, targeting P, and the tool result carries its identifier and queued state

#### Scenario: Fan-out in one turn

- **WHEN** the persona delegates three tasks to different personas in one turn
- **THEN** three tasks exist, each targeting its named persona, executed serially by the engine

#### Scenario: Self-delegation is rejected

- **WHEN** the delegate tool names the persona the conversation is running under as the target
- **THEN** the tool returns a structured error advising a target other than the current persona, and no task is created

#### Scenario: A market agent accepts as a target

- **WHEN** the persona calls delegate with target `{type: "a2a", ref}` naming an online catalog a2a entry
- **THEN** a task is created targeting that agent, executed as a remote task, and the tool result carries its identifier and queued state exactly like a persona target

#### Scenario: An unknown a2a ref is refused

- **WHEN** the delegate tool names an a2a ref absent from the catalog
- **THEN** the tool returns a structured error naming the unknown target and no task is created
