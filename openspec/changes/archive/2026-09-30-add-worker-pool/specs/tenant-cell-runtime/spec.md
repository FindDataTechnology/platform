## MODIFIED Requirements

### Requirement: A cell encapsulates one user's complete runtime state
The hosted deployment SHALL serve each user from a dedicated cell consisting of one platform server process, its interactive dsh agent runtime, an optional bounded pool of task-worker runtimes (see `worker-pool`), and a per-user data directory. All per-user mutable state — chat history, sessions, document library and search index, extension and MCP configuration, custom skills, preferences, cron jobs, tasks, and bots — SHALL be stored under that user's data directory and SHALL NOT be readable or writable from any other user's cell. Worker runtimes share the cell's composed profile and their state stays under the same data directory. Shared read-only inputs (application code, model gateway credentials) MAY be provided identically to every cell.

#### Scenario: two users' data are isolated
- **WHEN** users A and B each upload documents and hold chat sessions on the hosted deployment
- **THEN** user A's document library, chat history, and session list contain none of user B's items
- **AND** no API, tool call, or MCP tool available to user A can read user B's data

#### Scenario: per-user MCP and skills sets
- **WHEN** user A enables an MCP server or installs a custom skill in their cell
- **THEN** the change affects user A's cell only
- **AND** user B's available MCP servers and skills are unchanged

#### Scenario: workers stay inside the cell
- **WHEN** a cell runs task-worker runtimes
- **THEN** every worker's state lives under that cell's data directory
- **AND** no worker of another cell is reachable from it
