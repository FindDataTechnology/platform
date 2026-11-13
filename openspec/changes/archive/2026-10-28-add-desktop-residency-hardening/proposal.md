# add-desktop-residency-hardening — 常驻兜底硬化（本地集群的「一直活着」承诺）

## Why

「本地运行和管理多智能体集群」拍板时常驻被纳入 v1（2026-10-28 D4：纳入）：用户关窗、锁屏、重启、更新之后，集群必须还在跑，且坏了要看得见、修得动。现状盘点（侦察坐实）：自启本体**已经存在**——`electron/steward-install.js` 已实现 mac LaunchAgent（RunAtLoad+KeepAlive）与 Windows schtasks ONLOGON LIMITED，consent 三句已在 spec，drain-before-swap 更新也已经由 `desktop-supervisor` 立规。因此本 change 不是「做自启」，而是补三个真实缺口：**崩溃环无保护**（KeepAlive 无条件重生，坏版本可以无声刷屏）、**恢复后本地集群不保证收敛**（runner 启用态/本地部署随 steward 唤醒还原，无 spec 立约）、**双平台注册正确性无自动断言**（mac 的 launchctl 在 CI 不确定，win 侧 schtasks 路径无断言幕）。

## What Changes

- **崩溃环保护（新）**：常驻栈（steward 本身与其拉起的 cell/runner）连续启动失败达阈值时，SHALL 停止重试手臂（退避升级到冷却窗）并在状态面呈现「集群未健康」与最近一次失败原因；不得无限刷屏重生。
- **降级可见与一键修复（新）**：preferences/舰队页 SHALL 呈现常驻状态三态（已注册且健康 / 已注册未健康 / 未注册）与原因摘要，并提供「重新注册自启」修复动作（幂等，重装 LaunchAgent/schtasks 条目）。
- **恢复即收敛（新）**：steward 唤醒/登录/更新后拉起时，本地集群 SHALL 还原到声明态——插件启用位与本地 feed 令牌来自 settings（幂等铸造），本地部署以部署表为真源收敛（feed 声明即期望，runner 领回；无可部署条目时保持空编目健康）；睡眠/唤醒与电源事件后同样收敛。
- **双平台注册断言与 e2e（新）**：Windows 侧断言 schtasks 条目参数（ONLOGON/LIMITED/entry 名/稳定路径）；macOS 侧以注册产物断言替代 launchctl 运行时确定性（CI 不定时腿）；乘在途 `automate-nonweb-acceptance` 的 installer-e2e 轨加一幕「装→注册→重启→栈自起且集群收敛→卸载清场」。
- **卸载语义明文化（小）**：卸载 SHALL 移除自启注册、排空运行时，但 SHALL NOT 删除用户数据与本地部署记录（重装即恢复集群）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `desktop-supervisor`: 自启要求扩出「注册正确性断言」；新增「崩溃环保护与降级可见」「常驻状态面与一键修复」两条要求。
- `cell-lifecycle`: 新增「常驻恢复后的簇收敛」要求——唤醒/登录/更新/睡眠恢复后，本地集群（启用位、令牌、部署）收敛到声明态，未配置时零破坏。

## Impact

- **代码**：`electron/steward-install.js`（注册断言导出/幂等重注册）、`supervisor/steward.js` + `steward-policy.js`（崩溃环计数与冷却）、`supervisor/steward-main.js`（恢复收敛钩子）、`electron/preferences/*`（状态面与修复动作）、`server/routes/wanxing-fleet.js`（健康摘要透出）。
- **契约**：新增状态枚举与修复 IPC；autostart 注册参数不变（只加可断言导出），既有安装行为向后兼容。
- **风险**：崩溃环阈值定太紧会把慢启动误判为坏——阈值与冷却窗以实测启动时长（含冷启 dsh 载入）定，留可配。
