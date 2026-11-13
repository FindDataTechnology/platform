# Design: add-desktop-residency-hardening

## Context

侦察坐实：自启注册（mac LaunchAgent / win schtasks ONLOGON LIMITED）与 consent
三句、drain-before-swap 更新、spawned server 的自动重启都已在 `desktop-supervisor`
spec 与 `electron/steward-install.js` 里。本 change 只补三个真实缺口：崩溃环
无保护、恢复后簇收敛无立约、双平台注册正确性无自动断言。设计因此追求**最小
侵入**：不重构注册机制，只加计数/状态/断言三个面。

## Goals / Non-Goals

**Goals:**
- 坏版本不会无声刷屏重生；用户能从状态面看见并修。
- 重启/唤醒/更新后本地集群自行回来，且断网也可。
- 双平台注册正确性在 CI 可断言；e2e 一幕覆盖装→注册→重启→收敛→卸载。

**Non-Goals:**
- 自启注册机制本身重写（LaunchAgent/schtasks 不动，只加可断言导出）。
- 云席位桥的常驻（配对心跳失败不属本地集群健康）。
- 移动端常驻；集群运行时的性能调优（capacity 归 `add-local-fleet-control-plane`）。

## Decisions

### D1 崩溃环在 steward 策略层计数，不在 OS 注册层

KeepAlive（mac）与 schtasks ONLOGON 只负责「登录时拉起一次」，运行中的
存活由 steward 自己的监督环负责。计数落在 `steward-policy.js`：启动尝试
记数、健康稳定 N 秒后清零、连续失败达阈值进入冷却（记录 `lastFailure`
原因与时间）。理由：OS 层无法感知"启动失败"（LaunchAgent 的 KeepAlive 会
无条件重生），保护只能在我们自己的环里做。替代项「靠 OS ThrottleInterval」
只退避不停止、也不可见，否决。

### D2 状态来自 attach 探测，不以文件存在代替健康

既有 `attachSteward(dataDir)`（发现 + hello + 版本校验）已是现成的健康探针：
状态面三态由它派生（注册文件存在性 + attach 结果）。「已注册未健康」是
一等态——注册在而进程死必须可见。替代项「注册问题只报注册」会把坏态藏进
假绿。修复动作 = 重新注册（幂等 replace）+ 立即启动，且清除崩溃环计数。

### D3 收敛钩子放 steward-main 启动序列尾部，幂等

steward 启动序列末加一步 `convergeLocalCluster()`：读 settings 的插件启用位
与令牌（缺失则幂等补铸）、按部署表生成期望集、比对当前 feed 声明与
runner 领回结果，剔除孤儿（pack 已卸载）、报告计数。幂等是可重入的前提
（每次唤醒都跑）；断网不影响（feed 是本地路由）。**不新建第二真源**：期望
集就是部署表，feed 从它派生（`local-agent-registry-feed` 已立约）。

### D4 阈值与冷却窗按实测冷启动定，且可配

冷启 dsh 载入是慢的（桌面首启实测数秒到十余秒），阈值太紧会把慢启误判。
默认：连续 3 次失败进 5 分钟冷却，健康稳定 60s 清零计数；`STEWARD_CRASH_*`
系列环境键可覆盖（settings 驱动）。数值得在 win-smoke/mac e2e 上用真实时长
校准后落默认（任务里含校准步）。

### D5 双平台断言用注册产物，mac 不驱动 launchctl

mac 侧 CI 的 launchctl 确定性不足（在途 change `automate-nonweb-acceptance`
已就此裁定"注册正确性用断言替代"）：本 change 把注册计划的计算导出为可断言
产物（plist 文本/schtasks argv），单测直接断言其字段；win 侧同法断言 argv，
再在 win-smoke 真机上跑一次 schtasks 实际注册/查询。两平台都不依赖 GUI。

## Migration

- 无数据迁移；新增状态枚举与 IPC 为纯增量。崩溃环状态为进程内 + 落一份
  `steward-health.json`（dataDir），读取失败视为无历史（首启语义）。
- 回滚 = 撤状态面/收敛钩子；注册机制未改，旧版本互操作无碍。

## Verification

- 单测：注册产物断言（win argv / mac plist 字段）；幂等重注册；崩溃环计数与
  冷却状态机（含显式动作清零）；收敛函数幂等（同一部署表两跑结果一致）。
- e2e（乘 installer-e2e 轨）：装 → 注册断言 → 触发重启（win 默认腿）→ 栈自起
  + 集群收敛计数正确 → 卸载清场且用户数据/部署记录保留。
- 手动：mac dispatch 腿跑同一幕；睡眠唤醒一次（真机）看收敛与计数。
- 校准：崩溃环阈值以真实冷启动时长实测后落默认值，数值与实测写进任务注释。
