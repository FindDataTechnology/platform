## Why

舰队的节奏回合、集群扇出与委托唤醒等定时车道换 persona 靠整 child 重启（实测 5-10 秒/次，
`docs/vertical-packs.md:224`）——六人队一轮纯重启税 30-60 秒，且每次重启按当前 preset 重建全部
会话的 agent 上下文，用户自己的对话在轮间被 `waitForIdle` 挡住。桥的会话级 persona
（`preset/set`，parked 语义）已在产且 runner 侧（pod 共宿）已消费，cell 宿主从未接线——这是
`docs/agent-parallel-execution-explore.md` 切片①：零内存增量、去掉重启税，也是后续「承载可配」
（换身体不换会话）的技术前提。真并发不是本 change 目标：回合收尾的进程级串行是 dsh 硬限制
（probe-concurrent-turn-close 实证），本 change 只把「串行 + N 次重启」变成「串行」。

## What Changes

- **dsh-bridge 加 `setPreset({sessionId, presetId})` 透传**：按 child 世代维护「已驻留会话」
  集合（镜像 runner pod 的 prepared 纪律，`agent-runner/harness/dsh.js:54`），重启即清；
  child 未上报 `preset/set` 能力时明确报不支持，调用方走既有回退。
- **定时车道的 persona 回合停改运行时默认**：`runPersonaTurn` 不再 `switchPresetForJob`
  （重启换人设），改为把本回合 preset 驻留到本回合的子进程对话 id 上再首 prompt——
  舰队回合本就逐回合轮换对话 id（cron-module「逐回合全新」），驻留骑新 id；
  绑定会话的普通定时任务按 child 世代驻留一次。
- **运行时默认不被定时车道移动**：驻留路径下 `ctx.currentPreset` 与 `presets.patch.yml`
  的 `agentPreset` 不因定时回合改变，`restore`（还原本轮前 preset）在驻留路径成为 no-op；
  遗留回退路径保留原语义。
- **能力门控回退**：child 缺 `preset/set`（旧 child）或驻留会话已活且组合不符时，
  走与今天逐字节等价的「重启 + 还原」路径——回退是显式分支，不是静默失败。
- **聚合回合同法**：委托聚合的裁决 persona（`delegation-aggregator.js` 的 `switchPresetTo`）
  改骑同一驻留通道，不再为汇总回合重启 child。
- **聚合回合同法**：委托聚合的裁决 persona（`delegation-aggregator.js` 的 `switchPresetTo`）
  改骑同一驻留通道，不再为汇总回合重启 child。
- **读面审计结论（已核实，无需迁移）**：定时车道归属的 preset 输入本就是任务驱动
  （`fleet-events.js:92` 读 `request.targetRef.id`）；`ctx.currentPreset` 的其余消费点
  全在聊天车道（选择器/会话头/门面绑定），本 change 零触碰。

**不做**（Non-Goals）：每会话模型（model 仍走进程级 `switchModelTo`，漂移守卫
`normalizeModelForJob` 的强制断言不变）；worker pool / 真并发；用户对话车道的
preset 选择（`agent-preset-selection` 语义零变化）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cron-module`：**ADDED** 需求——定时/persona 回合的 persona 组合按会话驻留
  （park-before-first-prompt），运行时默认不被定时车道移动；能力门控与显式回退；
  绑定会话任务按 child 世代驻留。
- `scheduling-cluster-aware`：**MODIFIED** 集群扇出需求——本地 persona 成员的执行机制
  从「preset 切换」改为「会话驻留」，扇出后「还原运行时 preset」条款仅在遗留回退路径适用；
  成员恒串行与串行降级注记不变。

## Impact

- **代码**：`dsh-bridge.js`（wrapper + 世代集合 + 能力探测）；`server/cron-runner.js`
  （`runPersonaTurn` 执行序、集群扇出还原段、`switchPresetForJob` 降格为回退路径）；
  `server/delegation-aggregator.js`（聚合回合去重启）；归属读面审计
  （`server/fleet-events.js` / `server/fleet-reports.js` / `server/turn-request.js` 的
  currentPreset 消费点）。
- **契约**：`preset/set` 的 RPC 语义不变（`dsh-runtime-bridge` 既有需求 @204 已钉）；
  WS `current_preset` 事件语义不变（仍表示运行时默认）；会话头 `meta.agentPreset` 语义不变。
- **测试**：`scripts/test-cron-*.mjs` / 集群扇出 / 委托聚合相关单测需补驻留分支；
  真机验收口径 = 六人队一轮不再出现 child 重启（进程数与 spawn 日志为零）、
  运行时默认前后不变、旧 child 回退路径仍绿。
- **风险**：驻留失败落回退路径的判定必须可观测（日志 + 回合 detail 留痕）；
  `ctx.currentPreset` 消费点已逐点审计（定时车道归属本就任务驱动，聊天车道不动），
  但实现期仍须以 grep 复核防并行会话新增消费点。
