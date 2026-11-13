## ADDED Requirements

### Requirement: Resident form with a loopback control plane

The supervisor SHALL support two forms: embedded (constructed in-process by the Electron
main, today's behavior) and resident (a standalone process that outlives any UI session,
the desktop steward). The resident form SHALL expose a loopback-only control plane
(macOS Unix socket / Windows named pipe, accessible to the owning OS user only) carrying
status, start/stop, drain-quit, and steward-configuration operations. Every control-plane
message SHALL carry `protocolVersion`; a client whose major version is unsupported SHALL be
refused with an explicit version error rather than silent misparse. Discovery SHALL ride a
`steward.json` in the data root (socket path, protocolVersion,)
 and SHALL be single-user scoped.

#### Scenario: resident supervisor survives UI exit

- **WHEN** the supervisor runs in resident form and the user quits the Electron app
- **THEN** the supervisor, the runtime stack, and any fleet runner children keep running —
  only the UI client detached

#### Scenario: version mismatch refuses explicitly

- **WHEN** a client speaks a control-plane protocol major the resident supervisor does not
  support
- **THEN** the supervisor rejects the attach with an explicit unsupported-version error

### Requirement: UI attach with embedded fallback

The Electron app SHALL prefer attaching to a resident supervisor discovered via
`steward.json` and SHALL drive its existing IPC surface from that attachment. When no
resident supervisor exists and none was ever installed, the app SHALL fall back to the
embedded form byte-for-behavior with today (runtime lifetime follows the app — the
`manual` world). When a resident supervisor exists but is unreachable, the app SHALL offer
to start or repair it rather than silently constructing a second stack; it SHALL never run
two supervisors against one data root.

#### Scenario: attach preferred, never doubled

- **WHEN** the app starts and a healthy resident supervisor is discovered
- **THEN** the app attaches as a client and does not construct an embedded supervisor

#### Scenario: unreachable steward offers repair, not duplication

- **WHEN** `steward.json` names a control socket that refuses connection
- **THEN** the app offers to start/repair the resident supervisor and does not open a
  second runtime stack on the same data root

#### Scenario: no steward installed keeps the manual world

- **WHEN** no resident supervisor was ever installed and the user declined installation
- **THEN** the app runs its embedded supervisor exactly as before, and the platform holds
  no registration for this cell

### Requirement: Per-user autostart installation as an explicit, zero-admin step

Installing the steward SHALL be an explicit user action (a guided step in the fleet/plugin
settings) whose consent text names exactly three things: a background-resident service,
launch-at-login registration, and — once paired — heartbeat reporting to the platform.
Autostart SHALL register per-user only and SHALL require no administrator/root rights
(macOS LaunchAgent; Windows Scheduled Task or Run key). Uninstalling the app SHALL remove
the autostart registration and best-effort-stop the steward.

#### Scenario: consent names three facts before install

- **WHEN** the user initiates steward installation
- **THEN** the confirmation text itemizes background residency, launch-at-login, and the
  heartbeat reporting that follows pairing — and installation proceeds only on confirm

#### Scenario: no admin at any step

- **WHEN** the steward is installed on a stock macOS or Windows account without admin
  elevation
- **THEN** installation, autostart registration, and daily operation all succeed without
  requesting elevation

#### Scenario: app uninstall removes registration

- **WHEN** the desktop app is uninstalled
- **THEN** the autostart entry is removed and a best-effort steward stop is attempted

### Requirement: Residency policy execution on the desktop

The resident supervisor SHALL execute the cell's residency policy (see `cell-lifecycle`):
`always` keeps the runtime stack alive whenever the computer is on, independent of UI
sessions; `on_demand` runs the stack for UI sessions and for due persisted schedules
(reading the data-root task records exactly like the cloud duty ring) and drains after the
quiet period; the un-stewarded embedded form is the `manual` behavior. Installing the
steward SHALL default the cell to `always` — the install act IS the background-operation
consent — with `on_demand` selectable per deployment guidance for low-frequency duties.

#### Scenario: steward install defaults to always

- **WHEN** the steward is installed and no policy was previously chosen
- **THEN** the cell's residency policy is `always`, and the runtime stack stays alive
  across UI open/close cycles

#### Scenario: on_demand desktop wakes at a due schedule

- **WHEN** a stewarded desktop cell with policy `on_demand` has a persisted cron obligation
  come due while no UI is open
- **THEN** the steward starts the runtime stack, the round executes, and after the quiet
  period the stack drains again

### Requirement: Drain-before-swap updates with a stable autostart path

Updating the desktop app SHALL drain the resident supervisor before files are replaced:
the updater/installer SHALL signal drain-and-quit (supervisor drains runtime children and
exits), swap files against a stable, version-independent install path that the autostart
entry points at, and let the next login or explicit start bring up the new build. Rounds
missed inside the update window SHALL be covered by the task engine's existing catch-up on
the next boot.

#### Scenario: installer drains before replacing files

- **WHEN** an app update is installed while the resident supervisor is running
- **THEN** the supervisor receives drain-and-quit, runtime children stop in order, the
  process exits, and only then are program files replaced

#### Scenario: autostart entry survives updates

- **WHEN** an update completes
- **THEN** the launch-at-login registration still points at a stable path that now resolves
  to the updated build — no per-version registration edits
