## Purpose

Test-process hygiene for the `node --test` unit lane (`scripts/test-*.mjs`): no test run — however it ends — may leave spawned gateway/server/dsh processes or their throwaway store directories behind on the developer's machine. Covers spawning, teardown, and self-healing after untrappable aborts.

## ADDED Requirements

### Requirement: Every spawned test server is group-owned through the shared helper

Any long-lived child process a test script spawns (gateway, single-process server, stub fronting cells) SHALL be spawned through the shared test-server helper as a process-group leader, so that every descendant it will ever spawn — dsh cells, worker bridges, stub servers — inherits that group and remains reachable by a single group-wide signal. A test script SHALL NOT spawn such servers with a bare `spawn` that leaves descendants outside any killable group.

#### Scenario: descendants inherit the group

- **WHEN** a gateway spawned through the helper starts a dsh cell for a user
- **THEN** the cell's process group is the gateway's own group, so a group signal reaches the whole tree in one operation

#### Scenario: adoption is universal across the lane

- **WHEN** any script in `scripts/test-*.mjs` that spawns a server runs
- **THEN** it does so through the shared helper — no spawning script in the lane retains a bare-spawn path

### Requirement: Owner exit tears down everything it spawned

When a test-script process ends for any reason other than an untrappable kill — normal completion, assertion failure, uncaught error, SIGINT, or SIGTERM — every server group that script registered SHALL be torn down, without relying on the script's own `finally` blocks having run.

#### Scenario: assertion failure mid-test still collects the servers

- **WHEN** a test throws before reaching its cleanup code and the script process exits
- **THEN** all server groups it registered are killed rather than orphaned

#### Scenario: Ctrl-C during a run collects the servers

- **WHEN** the operator interrupts a test run and the script process receives SIGINT
- **THEN** every registered server group is torn down before the script process exits

### Requirement: Teardown is a group ladder, never a lone reaper kill

Tearing down a spawned server SHALL mean signaling its entire process group: SIGTERM to the group first (letting the server run its graceful shutdown ladder and its children receive the signal directly), then, only after a bounded shared grace period (20 s) has expired without group exit, SIGKILL to the group. Teardown SHALL NOT escalate by killing only the spawned server's single PID: killing the process responsible for reaping its children while those children survive orphans them.

#### Scenario: graceful stop within the grace

- **WHEN** a stopped server and its cells exit on SIGTERM within the grace period
- **THEN** no SIGKILL is delivered and the group is gone

#### Scenario: a wedged server is force-killed as a group

- **WHEN** a server ignores SIGTERM past the grace period
- **THEN** the whole group receives SIGKILL, and the server's children die in the same operation instead of being reparented to launchd

### Requirement: Orphaned registrations self-heal on the next test run

Each spawned server group SHALL be registered with its owning script process and its throwaway store root before the server becomes capable of spawning children. When the helper is loaded by any later test run, every registration whose owning process is no longer alive SHALL have its group SIGKILLed and its store root deleted; a registration whose owner appears alive SHALL be left untouched — a recycled owner PID may at worst delay a corpse's cleanup, never cause a live run's processes to be killed.

#### Scenario: a SIGKILLed script's leak is cleaned by the next run

- **WHEN** a test script is SIGKILLed mid-run, leaving a registered gateway and its cells orphaned, and any later test run loads the helper
- **THEN** the orphaned group is killed and its store root removed, without operator action

#### Scenario: a concurrent live run is never touched

- **WHEN** the helper is loaded while another test run's script processes are alive with their servers registered
- **THEN** those registrations are skipped and their processes keep running

#### Scenario: no residue after a clean full run

- **WHEN** the full unit lane finishes normally
- **THEN** no spawned server or dsh process remains in the process table, and no throwaway store directory remains on disk
