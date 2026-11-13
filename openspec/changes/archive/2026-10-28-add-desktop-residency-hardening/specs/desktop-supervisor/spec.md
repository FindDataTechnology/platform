# desktop-supervisor Specification Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
