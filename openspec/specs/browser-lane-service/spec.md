# browser-lane-service Specification

## Purpose
pod 级的共享浏览器服务：多个租户 cell 共用一份浏览器运行时与一份浏览器驱动进程，而各自的浏览器状态（登录态、标签页、凭据）互不可见。它把浏览器这条"不承载回话回合"的车道从"按 cell 复制"改成"按 pod 共享"，同时不削弱 cell 作为隔离原语的语义。

## Requirements

### Requirement: 共享浏览器服务按 pod 部署一份

部署 SHALL 在每个承载 cell 的 pod 内提供一份共享浏览器服务；同一 pod 内的任意数量 cell SHALL 连到同一份服务，而非各自拉起浏览器运行时或浏览器驱动进程。pod 不供应浏览器运行时、或部署显式关闭浏览器车道时，共享服务 SHALL 不出现，cell 侧的车道条目也 SHALL 不出现（工具不可见，等同于既有 absent 形态）。

#### Scenario: 多 cell 共用一份服务
- **WHEN** 一个 pod 承载三个 cell 且浏览器车道已供应
- **THEN** pod 内只有一份共享浏览器服务进程，且这些 cell 都通过它使用浏览器工具

#### Scenario: 未供应的 pod 不出现服务
- **WHEN** pod 没有浏览器运行时且未配置远程端点
- **THEN** 不启动共享浏览器服务，cell 的车道条目缺省，模型看不到任何浏览器工具

### Requirement: 每 cell 独立的浏览器状态

共享服务 SHALL 为每个接入的 cell 会话提供独立的浏览器上下文：cookie、登录态、标签页、下载与产物 SHALL NOT 跨 cell 可见。同一 cell 内的多次会话 SHALL 按该 cell 自己的策略共享或隔离其状态。共享一个浏览器进程 SHALL NOT 使两个 cell 的站点登录态互相可见。

#### Scenario: 两个 cell 同时登录同一站点互不干扰
- **WHEN** cell A 与 cell B 在同一 pod 内分别登录同一站点的不同账号
- **THEN** 任一 cell 的后续操作只看到自己账号的登录态，另一 cell 的登录态不可见

#### Scenario: 会话结束后不残留给其它 cell
- **WHEN** cell A 的浏览器会话结束，cell B 随后访问同一站点
- **THEN** cell B 呈现未登录态，除非 cell B 自己登录过

### Requirement: 浏览器产物按 cell 可读性路由

共享服务产生的产物（截图、下载、页面导出）SHALL 落进发起该调用的 cell 可读的位置，并以该 cell 既有的文件可见性语义对外提供；调用未指定文件名时的自动命名产物 SHALL 同样如此。一个 cell SHALL NOT 因共享服务而能读到另一 cell 的浏览器产物。

归属判定 SHALL 依据「本次调用之前共享根目录里没有这个文件名」这一事实（调用开始前的名字快照），SHALL NOT 依据墙上时钟与文件时间戳的比较：文件系统会把 mtime 向下取整到自己的 tick（Linux 常见 1–10ms，某些 overlay/tmpfs 更粗），因此一次快速调用写下的自动命名文件可能带一个早于调用起始时刻的 mtime，从而不被认领、留在共享根目录里，被下一个 cell 的调用顺手扫走——那正是本条禁止的跨 cell 泄漏。时间戳比较 MAY 仅作为拿不到快照时的退路。

#### Scenario: 截图落在发起方 cell
- **WHEN** cell A 的会话要求截图且未指定路径
- **THEN** 该文件出现在 cell A 的可读文件面并可经既有文件接口获取

#### Scenario: 跨 cell 读不到产物
- **WHEN** cell B 尝试按其文件接口列举或获取 cell A 的浏览器产物
- **THEN** 该产物对 cell B 不可见

#### Scenario: 粗粒度文件时间戳不改变归属
- **WHEN** 一次调用写下的自动命名产物的 mtime 被文件系统取整到早于该调用起始时刻
- **THEN** 该产物 SHALL 仍被认领进发起方 cell 的目录
- **AND** 共享根目录 SHALL NOT 残留该文件（否则它就等着被下一个 cell 扫走）

### Requirement: 共享服务故障显式降级且不回落本地

共享浏览器服务不可达或崩溃时，各 cell 的浏览器工具 SHALL 按既有 MCP 连接失败语义降级（记录原因、工具不可用、其余工具不受影响），且部署 SHALL NOT 在 cell 内回退拉起本地浏览器来顶替。服务恢复后，后续调用 SHALL 自动可用，无需重启 cell。

#### Scenario: 服务不可达时工具变灰
- **WHEN** 共享浏览器服务不可达
- **THEN** 各 cell 的浏览器工具调用失败并记录明确原因，同 cell 的其它 MCP 工具照常工作

#### Scenario: 不静默回落
- **WHEN** 共享服务不可达且部署曾配置过共享端点
- **THEN** pod 内不出现按 cell 的本地浏览器驱动进程

#### Scenario: 恢复后自动可用
- **WHEN** 共享服务恢复
- **THEN** 已有 cell 无需重启即可再次使用浏览器工具

### Requirement: cell 身份不由客户端自报

共享服务 SHALL 以部署内的可信来源确定调用方属于哪个 cell，SHALL NOT 以客户端自报的标识决定隔离边界与产物归属。

#### Scenario: 伪造标识无效
- **WHEN** 一个连接声称自己属于另一个 cell
- **THEN** 隔离边界与产物归属仍按部署内的真实来源判定
