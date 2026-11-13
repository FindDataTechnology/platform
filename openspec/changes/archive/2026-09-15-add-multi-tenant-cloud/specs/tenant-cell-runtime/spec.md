# tenant-cell-runtime Specification

## Purpose

Defines the per-user isolation unit ("cell") of the hosted multi-user deployment: one platform server process with its own dsh runtime and per-user data directory, such that no user's data, configuration, or agent activity is observable or reachable from another user's cell.

## ADDED Requirements

### Requirement: A cell encapsulates one user's complete runtime state

The hosted deployment SHALL serve each user from a dedicated cell consisting of one platform server process, its dsh agent runtime, and a per-user data directory. All per-user mutable state — chat history, sessions, document library and search index, extension and MCP configuration, custom skills, preferences, cron jobs, and bots — SHALL be stored under that user's data directory and SHALL NOT be readable or writable by any other user's cell. Shared read-only inputs (application code, model gateway credentials) MAY be provided identically to every cell.

#### Scenario: two users' data are isolated

- **WHEN** users A and B each upload documents and hold chat sessions on the hosted deployment
- **THEN** user A's document library, chat history, and session list contain none of user B's items
- **AND** no API, tool call, or MCP tool available to user A can read user B's data

#### Scenario: per-user MCP and skills sets

- **WHEN** user A enables an MCP server or installs a custom skill in their cell
- **THEN** the change affects user A's cell only
- **AND** user B's available MCP servers and skills are unchanged

### Requirement: Cell state survives restarts and stays on local disk

A cell's data directory SHALL be the single root of its persistent state, addressed by an environment-provided path, so that stopping and starting a cell (same user, same data directory) restores that user's sessions, library, extensions, and scheduled jobs. A cell's SQLite databases SHALL reside on local (non-network-filesystem) storage.

#### Scenario: cell restart resumes state

- **WHEN** a user's cell process exits and is started again against the same data directory
- **THEN** the user's chat sessions resume from persisted history
- **AND** their document library, enabled MCP servers, custom skills, and cron jobs are restored

#### Scenario: no writable state outside the data directory

- **WHEN** a cell runs in hosted mode
- **THEN** every file it creates or modifies lives under its per-user data directory or per-user agent-home directory
- **AND** a fresh cell started with an empty data directory presents first-run state (no residue from other users or prior runs elsewhere)

### Requirement: Single-process modes preserve existing behavior

Running the platform server without the hosted-mode configuration SHALL preserve today's single-process behavior: one server, one dsh runtime, one data directory, optional auth, serving all connected clients. The packaged desktop app SHALL continue to run this way against its per-install data directory.

#### Scenario: dev mode unchanged

- **WHEN** the server is started without hosted-mode configuration
- **THEN** it serves all clients from one runtime and one data directory exactly as before this change

#### Scenario: desktop app unchanged

- **WHEN** the packaged desktop app starts
- **THEN** it runs its local server and dsh runtime against the install's user-data directory with its configured auth mode, independent of any cloud deployment
