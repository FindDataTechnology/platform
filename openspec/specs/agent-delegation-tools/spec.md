## Purpose

Every persona can delegate work to other personas from the conversation: MCP tools hand tasks to the cell's task engine, task cards show live progress in the chat, and a finished fan-out comes back as an aggregation turn in the initiating session. This is the user-facing half of the 指挥层 — the engine's second front-end beside scheduling.

## Requirements

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

### Requirement: Delegation is permission-gated
Dispatching through the delegate tool SHALL pass through the cell's existing permission modes: under echo mode the user confirms the tool call before any task is created; under permissive modes it proceeds. The tool result SHALL report token spend of the execution when the runtime reports usage.

#### Scenario: Echo mode asks before dispatch
- **WHEN** a persona calls delegate while the cell runs echo permission mode
- **THEN** the user is asked to confirm the tool call
- **AND** no task exists unless confirmed

### Requirement: Task cards render in the conversation
A delegation tool invocation SHALL render in the conversation as a task card — not raw tool output — showing the target persona, prompt summary, lifecycle state, and token spend when available, updating live from the task event surface. The card's actions reconcile with the /tasks list.

#### Scenario: Card on delegation
- **WHEN** the persona delegates a task during a conversation
- **THEN** the tool invocation renders as a task card with target persona, prompt summary, and queued state

#### Scenario: Card tracks the lifecycle
- **WHEN** the delegated task starts and then finishes while the conversation is open
- **THEN** the card updates to running and then the terminal state without a manual refresh

### Requirement: Progress and result tools read delegation state
The progress tool SHALL return the live status of tasks delegated in the current session's conversation; the result tool SHALL return a finished task's recorded output text (and error gist for failures). Both SHALL name unknown identifiers with a structured error.

#### Scenario: Progress mid-execution
- **WHEN** the persona calls progress while a delegated task is running
- **THEN** the tool result reports that task's running state and elapsed time

#### Scenario: Result of a finished task
- **WHEN** the persona calls result for a task whose execution finished
- **THEN** the tool result carries the recorded output text or the error gist

### Requirement: Finished fan-outs inject an aggregation turn
When every task delegated in one conversation turn holds a terminal state (done, failed, or interrupted), the system SHALL inject one completion turn into the initiating session prompting its persona to summarize the children's outcomes, including each task's result reference. The injection SHALL queue behind any streaming turn in the cell and SHALL render as a visibly task-authored system turn, not a user bubble. A fan-out with unfinished tasks SHALL NOT inject.

#### Scenario: Aggregation follows the last finisher
- **WHEN** two delegated tasks finish at different times
- **THEN** the aggregation turn is injected only after the later one reaches its terminal state

#### Scenario: Injection waits for a busy turn
- **WHEN** all delegated tasks are finished while a turn is streaming in the cell
- **THEN** the aggregation turn waits for the streaming turn to complete, then is delivered exactly once

#### Scenario: Partial failure still aggregates
- **WHEN** a fan-out ends with one done and one failed task
- **THEN** the aggregation turn names both outcomes, including the failure's gist
