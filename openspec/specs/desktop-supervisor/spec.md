# desktop-supervisor Specification

## Purpose
Governs the Electron main process, which runs no application logic and instead supervises the backend as a child process. The shared, Electron-agnostic `supervisor/` package owns the orchestration: descriptor registry, startup with health readiness, health checking, automatic restart, ordered shutdown, status inspection, log capture, and port management.

## Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional. A descriptor's `enabled` flag SHALL be resolved from the injected environment at supervisor construction, so an optional plugin service (openspec: desktop-fleet-runner) ships preinstalled yet stays unstarted until its switch is persisted and the app restarts.

#### Scenario: App launches with the default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads the `server-js` descriptor
- **AND** begins orchestrating it according to its declared dependencies

#### Scenario: A disabled plugin descriptor is skipped

- **WHEN** the app starts without the Wanxing plugin switch enabled in settings
- **THEN** the supervisor marks the `agent-runner-js` descriptor disabled and never spawns it

#### Scenario: An enabled plugin descriptor starts with its own health probe

- **WHEN** the app starts with the Wanxing plugin switch enabled
- **THEN** the supervisor starts `agent-runner-js` and polls its own health endpoint independently of `server-js`

### Requirement: Startup waits for health readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it. The app window SHALL open only after the backend reports healthy.

#### Scenario: window opens only after the backend is healthy
- **WHEN** the app starts
- **THEN** the supervisor starts `server-js` and polls its health endpoint
- **AND** the `BrowserWindow` is created only once that health check passes

#### Scenario: dependents wait for their dependency
- **WHEN** a descriptor declares a dependency on another server
- **THEN** the supervisor SHALL NOT start it until the dependency's health check passes

### Requirement: Health checking per transport
The supervisor SHALL health-check each running server on an interval using a transport-appropriate probe: an HTTP `GET` for `http-port` / `http-external` servers, and a TCP connection for descriptors that declare a `tcp` health kind.

#### Scenario: HTTP server health
- **WHEN** `server.js` is running on its assigned port
- **THEN** the supervisor periodically issues an HTTP health request and marks it healthy on a 2xx response

#### Scenario: TCP server health
- **WHEN** a descriptor declares a `tcp` health kind
- **THEN** the supervisor marks it healthy when a TCP connection to its port succeeds

### Requirement: Automatic restart on unexpected failure
The supervisor SHALL restart a server process if it exits unexpectedly, subject to a backoff policy, and SHALL NOT restart a server that exited because the app is shutting down.

#### Scenario: crashed server self-heals
- **WHEN** a spawned server process exits unexpectedly
- **THEN** the supervisor restarts it after a backoff delay
- **AND** the window remains unaffected

#### Scenario: no restart during shutdown
- **WHEN** the user quits the app
- **THEN** the supervisor stops all servers without triggering restart logic

### Requirement: Ordered shutdown
The supervisor SHALL stop servers in reverse dependency order on app quit, terminating each child process gracefully and then forcibly after a timeout.

#### Scenario: shutdown order
- **WHEN** the app quits
- **THEN** the supervisor stops the spawned servers in reverse startup order, terminating each child process gracefully and then forcibly after a timeout

### Requirement: Status inspection
The supervisor SHALL expose the live status of every server - id, state, pid, assigned port, last health result, restart count, and recent log lines - for display in the app.

#### Scenario: inspect server status
- **WHEN** the UI requests supervisor status
- **THEN** the supervisor returns each server's current state and its recent log lines

### Requirement: Log capture
The supervisor SHALL capture each child process's stdout and stderr into a per-server ring buffer and SHALL surface them through the status inspection API.

#### Scenario: child stderr captured
- **WHEN** a child server writes to stderr
- **THEN** the supervisor appends it to that server's log ring buffer
- **AND** it is retrievable via status inspection

### Requirement: Port management for spawned servers
The supervisor SHALL assign a free localhost port to each spawned port-speaking server at launch and SHALL pass the resolved URLs of sibling servers into each child's environment. When a fixed port is configured for `server-js` (`DESKTOP_SERVER_PORT`, set by the packaged app so the Logto redirect URI stays registerable), the supervisor SHALL use that port exclusively: if it cannot bind, startup SHALL fail with a visible error rather than silently falling back to a random port. The packaged app SHALL inject the auth configuration (`AUTH_MODE=logto`, `LOGTO_ENDPOINT`, the public `LOGTO_APP_ID`, `LOGTO_CLIENT_TYPE=public`, `SESSION_TTL_HRS=720`) into the `server-js` child environment from its bundled settings file.

#### Scenario: server.js receives a dynamic free port
- **WHEN** the supervisor starts `server.js` without a fixed port configured
- **THEN** it selects a free localhost port and passes it into the child's environment
- **AND** the Electron window loads `http://localhost:<port>` once the health check passes

#### Scenario: fixed port is used exclusively
- **WHEN** `DESKTOP_SERVER_PORT=47600` is set
- **THEN** `server.js` binds `127.0.0.1:47600` and the window loads that port

#### Scenario: fixed-port conflict surfaces a visible error
- **WHEN** the fixed port is already taken by another process
- **THEN** the supervisor fails startup with the existing backend-error window instead of silently using a random port

#### Scenario: auth environment injected from bundled settings
- **WHEN** the packaged app starts
- **THEN** the `server.js` child receives the logto public-client auth configuration from the bundled settings file
- **AND** local development without a settings file behaves as before (random port, no auth env)

### Requirement: Health probes target the bound address
The supervisor MUST probe a server at the address that server actually bound, rather than at an independently hardcoded hostname.

#### Scenario: Probe follows the pinned bind address
- **WHEN** the injected child environment pins `HOST` to a concrete address (e.g. the desktop's `127.0.0.1`)
- **THEN** the health probe URL uses that same address
- **AND** a bind-family mismatch cannot present as healthy

#### Scenario: localhost-only bind no longer hides from the renderer
- **GIVEN** a host where `localhost` resolves to `::1` only
- **WHEN** the backend binds `localhost` while the renderer loads `127.0.0.1`
- **THEN** the probe—following the bind address—reflects what the renderer can reach
- **AND** a green probe implies the renderer's target is reachable

### Requirement: Desktop backend binds IPv4 loopback
On packaged desktop runs the backend MUST bind a concrete IPv4 loopback address instead of the hostname `localhost`.

#### Scenario: Packaged run binds 127.0.0.1
- **WHEN** the app is packaged
- **THEN** the seeded desktop settings include `HOST=127.0.0.1` for the spawned backend
- **AND** the backend listens on IPv4 loopback (verifiable by confirming an IPv4 listener on the desktop port)

#### Scenario: Dev and container runs keep their own binding
- **WHEN** running in dev or in a container
- **THEN** `HOST` remains caller-controlled (including `0.0.0.0` for container reachability)
- **AND** the desktop default does not override an explicit host

### Requirement: Main process logs to a user-readable file
The packaged main process MUST mirror its console output to a log file inside the user data directory.

#### Scenario: Packaged console output is persisted
- **WHEN** the app runs packaged (where no console exists)
- **THEN** every main-process log, warning and error is appended to a log file under the user data directory
- **AND** the application menu exposes an action that reveals that file

#### Scenario: Log failure never breaks the shell
- **WHEN** the log file cannot be written (read-only disk, full disk)
- **THEN** the failure is swallowed
- **AND** the application continues to boot

### Requirement: Window is revealed only after it paints
The main window MUST stay hidden until the renderer finishes loading, and MUST never leave the user with an unpainted window.

#### Scenario: Window shows after first successful load
- **WHEN** the window finishes loading its content
- **THEN** the window becomes visible
- **AND** an unpainted dark backdrop is never shown as if it were the app

#### Scenario: A failed load retries within a bound
- **WHEN** a load fails
- **THEN** the load is retried with a bounded retry count and delay
- **AND** repeated failures do not spin forever

#### Scenario: A hung load still reveals the window
- **WHEN** neither a successful nor a failed load arrives within a short grace period
- **THEN** the window is revealed regardless
- **AND** the user is never left with no window at all

### Requirement: In-app render self-test
The app MUST be able to verify, on request, that its own window rendered real content and report the result as an exit status.

#### Scenario: Self-test reports a rendered window
- **GIVEN** the self-test is enabled by environment variable
- **WHEN** the window has loaded and mounted its UI
- **THEN** the app reads live DOM state (mounted root, rendered text, document title)
- **AND** captures the renderer's own frame buffer
- **AND** writes a machine-readable report plus a screenshot
- **AND** exits with status 0

#### Scenario: Self-test reports an unrendered window
- **GIVEN** the self-test is enabled
- **WHEN** the window cannot load content (renderer error, unreachable backend)
- **THEN** the report records the failure reason
- **AND** the app exits with a non-zero status

#### Scenario: Self-test is inert unless enabled
- **WHEN** the environment variable is absent
- **THEN** normal runs perform no self-test and do not exit on their own

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
the autostart registration and best-effort-stop the steward. **The registration SHALL be
assertable without relying on OS runtime behavior: the installer SHALL expose the exact
registration artifact and its parameters for verification — on Windows the scheduled-task
argument vector (`schtasks` entry name, ONLOGON trigger, LIMITED run level) and the stable
version-independent target path; on macOS the LaunchAgent plist contents (RunAtLoad,
KeepAlive, program arguments, stable path). Registration SHALL be idempotent: re-running
it replaces the entry in place, never duplicating it.**

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

#### Scenario: Windows registration is assertable

- **WHEN** the registration plan is computed on Windows
- **THEN** it yields the schtasks argument vector with the entry name, ONLOGON trigger, LIMITED run level, and the stable target path — verifiable by assertion without executing schtasks

#### Scenario: macOS registration artifact is assertable

- **WHEN** the registration plan is computed on macOS
- **THEN** the produced plist carries RunAtLoad=true, KeepAlive, program arguments and the stable path, verifiable by parsing the plist rather than driving launchctl

#### Scenario: re-registration is idempotent

- **WHEN** registration runs twice (e.g. the repair action)
- **THEN** exactly one entry exists afterward, pointing at the same stable path

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

### Requirement: 崩溃环保护

常驻栈（steward 自身与其拉起的 cell/runner）连续启动失败 SHALL 以计数 + 退避
策略处理：达到阈值后 SHALL 停止即时重试并进入冷却窗（窗口内不再自动重生），
SHALL NOT 无限重生刷屏。冷却窗结束后的首次尝试失败 SHALL 重新计时。用户显式
启动/修复动作 SHALL 清除计数并立即重试。阈值与冷却窗 SHALL 可配置且默认值以
实测冷启动时长（含 dsh 载入）留出余量，避免慢启动被误判。

#### Scenario: 反复失败进入冷却

- **WHEN** 常驻栈连续启动失败达阈值
- **THEN** 自动重生停止并进入冷却窗，状态面呈现未健康与最近失败原因

#### Scenario: 显式动作立即重试

- **WHEN** 用户在冷却窗内点击「重新注册自启/立即启动」
- **THEN** 计数清零、立即尝试一次，成功则恢复健康态

### Requirement: 常驻状态面与修复动作

桌面 SHALL 在设置面呈现常驻三态——已注册且健康 / 已注册未健康（含原因摘要）/
未注册——并在「未注册」与「未健康」两态提供修复动作：重新注册自启（幂等，
见上）与立即启动。状态 SHALL 来自 steward 的真实应答（attach 探测），SHALL NOT
以文件存在代替健康（注册在而进程死必须显示未健康）。

#### Scenario: 注册在而进程死显示未健康

- **WHEN** 注册产物存在但 steward 不响应
- **THEN** 状态面呈现「已注册未健康」并给出原因摘要与修复入口，而非显示为健康

#### Scenario: 未注册时如实提示

- **WHEN** 从未安装过 steward
- **THEN** 状态面呈现「未注册」，说明常驻的好处与代价，动作走既有 consent 流程
