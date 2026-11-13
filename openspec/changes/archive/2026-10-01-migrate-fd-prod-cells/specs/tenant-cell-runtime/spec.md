# tenant-cell-runtime Delta

## MODIFIED Requirements

### Requirement: A cell encapsulates one user's complete runtime state
The hosted deployment SHALL serve each user from a dedicated cell consisting of one platform server process, its interactive dsh agent runtime, an optional bounded pool of task-worker runtimes (see `worker-pool`), and a per-user data directory. All per-user mutable state — chat history, sessions, document library and search index, uploaded attachment originals, resource library and its stored bytes, the agent workspace and every file the agent produces, extension and MCP configuration, custom skills, preferences, cron jobs, tasks, and bots — SHALL be stored under that user's data directory (the workspace MAY sit beside it behind the same per-user root) and SHALL NOT be readable or writable from any other user's cell. Worker runtimes share the cell's composed profile and their state stays under the same data directory. Shared read-only inputs (application code, model gateway credentials) MAY be provided identically to every cell.

#### Scenario: two users' data are isolated
- **WHEN** users A and B each upload documents and hold chat sessions on the hosted deployment
- **THEN** user A's document library, chat history, and session list contain none of user B's items
- **AND** no API, tool call, or MCP tool available to user A can read user B's data

#### Scenario: produced files are isolated
- **WHEN** user A's agent writes a file during a turn
- **THEN** the file lands under user A's per-user root
- **AND** user B cannot retrieve it through any file-serving route, tool call, or resource-library listing

#### Scenario: uploads and resources are isolated
- **WHEN** user A uploads an attachment or saves a resource
- **THEN** the stored bytes live under user A's per-user root
- **AND** user B's document list, resource list, and file routes cannot reach them

#### Scenario: per-user MCP and skills sets
- **WHEN** user A enables an MCP server or installs a custom skill in their cell
- **THEN** the change affects user A's cell only
- **AND** user B's available MCP servers and skills are unchanged

#### Scenario: workers stay inside the cell
- **WHEN** a cell runs task-worker runtimes
- **THEN** every worker's state lives under that cell's data directory
- **AND** no worker of another cell is reachable from it

## ADDED Requirements

### Requirement: Each cell boots with a per-user writable agent workspace
The cell spawner SHALL pin every cell's agent workspace to a directory under that cell's per-user root (the pinned value overriding any inherited environment), and SHALL create it with the cell process's ownership before the cell starts. The pin SHALL flow through the existing workspace boot-resolution chain (`AGENT_WORKSPACE` pin > persisted preference > process cwd) unchanged; a cell whose pin is rejected SHALL NOT silently fall back to a directory that is shared across cells — the fallback cwd tier applies only within the cell's own per-user root, and the rejection SHALL be visible in the cell's boot log.

#### Scenario: a fresh cell writes and serves produced files
- **WHEN** a user's cell starts for the first time and the agent writes a file during a turn
- **THEN** the file lands in the cell's pinned workspace under the user's root
- **AND** the file is downloadable through the cell's file route and savable into the cell's resource library

#### Scenario: two cells never share a workspace
- **WHEN** two users' cells run in the same hosted deployment
- **THEN** each cell's workspace path is distinct and neither path is an ancestor of the other
- **AND** a workspace path rejection in one cell leaves the other cell's workspace untouched

#### Scenario: inherited environment cannot merge workspaces
- **WHEN** the gateway process itself carries an AGENT_WORKSPACE value in its environment
- **THEN** every cell still boots with its own per-user workspace (the spawner's pin wins)
- **AND** no two cells resolve to the same workspace directory

### Requirement: Marketplace and serving planes are deployment-level, not per-cell
The hosted deployment's sessionless lanes SHALL be owned outside any user's cell: the pack marketplace registry (packs, versions, subscriptions, deployment bookkeeping) SHALL live at the gateway's data root, so packs outlive and cross cells; anonymous pack skill reads SHALL be answered by the gateway from that registry without spawning any cell; and deployed Agent Services SHALL run on the deployment's runner (ADR-0004) reachable through the registry's proxy — a cell SHALL never host an Agent Service endpoint. The session-share lane keeps its existing owner-impersonation contract (see `session-share`).

#### Scenario: an anonymous pack skill read spawns nothing
- **WHEN** an unauthenticated caller fetches a published pack's skill markdown route
- **THEN** the gateway answers from its shared pack registry
- **AND** no cell is started or consulted

#### Scenario: a deploy belongs to the deployment, not the deployer's cell
- **WHEN** any authenticated user deploys a pack version as an Agent Service
- **THEN** the deployment is recorded in the gateway-level registry and the service answers on the deployment's runner
- **AND** the deployer's cell (and every other cell) hosts no service endpoint

#### Scenario: an unknown pack fails closed
- **WHEN** a sessionless request names a pack the gateway-level registry does not hold
- **THEN** the gateway rejects it
- **AND** no cell is spawned as a side effect
