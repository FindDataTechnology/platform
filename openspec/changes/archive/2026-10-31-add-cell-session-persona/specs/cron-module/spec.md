## ADDED Requirements

### Requirement: 定时回合的 persona 组合按会话驻留且不动运行时默认

定时车道的 persona 回合（节奏任务、集群扇出本地成员、委托聚合回合——一切经 persona 回合执行器的定时面）SHALL 以**会话驻留**换 persona：执行器 SHALL 在本回合子进程对话 id 的首 prompt 之前把该回合的目标 preset 驻留（park）到该会话，由会话惰性创建/恢复时挂载（既有 `preset/set` parked 语义）；**运行时的部署默认 preset SHALL NOT 被定时车道移动**——定时回合执行前后，运行时默认与 `presets.patch.yml` 的 `agentPreset` 保持回合前的值。

驻留纪律分两形：舰队成员回合（逐回合全新对话 id）SHALL 每回合对其新对话 id 驻留一次；绑定会话续执行的普通定时任务 SHALL 按 child 世代驻留——child 重启后的首次回合重驻留，会话在当前 child 已活时不重复驻留调用。

门控与回退 SHALL 显式：当运行时未上报 `preset/set` 能力（旧 child），或驻留目标会话在当前 child 已活且其组合 persona 与本回合目标 preset 不一致时，执行器 SHALL 走遗留回退路径——与既有行为逐字节等价（重启换默认执行、回合后还原），且回退发生 SHALL 留痕（日志与回合执行记录可见），MUST NOT 静默降级。

定时车道的岗位归属解析 SHALL 以回合自身的目标 preset 为输入（任务携带/驻留值），SHALL NOT 以运行时默认 preset 推断回合 persona；归属判定本身仍复用既有 resolveAttribution 单一规则，不引入第二套身份判定。用户对话车道（「与谁对话」选择器、聊天 preset 切换）语义 SHALL 零变化。

#### Scenario: 舰队多成员一轮零重启

- **WHEN** 一支六人舰队的一轮多成员回合逐成员执行
- **THEN** 全程运行时子进程零重启，每成员回合以自己的 persona 组合执行
- **AND** 回合前后运行时默认 preset 不变，用户对话车道不受定时回合影响

#### Scenario: 绑定会话任务跨 child 世代驻留

- **WHEN** 一个绑定会话的普通定时任务在 child 重启后触发
- **THEN** 本回合首 prompt 前该会话被重新驻留任务 preset，会话按任务 preset 组合续执行
- **AND** 同一 child 世代内的后续回合不重复驻留调用

#### Scenario: 旧 child 显式回退

- **WHEN** 运行时未上报 `preset/set` 能力
- **THEN** 回合走既有「重启换默认 + 回合后还原」路径，行为与本次变更前逐字节等价
- **AND** 回退留痕可查，不是静默行为

#### Scenario: 活会话组合不符显式回退

- **WHEN** 驻留目标会话在当前 child 已活，且其组合 persona 与本回合目标 preset 不一致
- **THEN** 执行器走遗留回退路径并留痕，不静默沿用不符组合，也不拒绝执行

#### Scenario: 归属解析读回合自身 preset

- **WHEN** 一个无 sourceTag 的委托唤醒 persona 回合结束并产出回合结果事件
- **THEN** 岗位归属解析以该回合的目标 preset 落位，运行时默认的当前值不影响归属
