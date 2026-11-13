# dsh-contracts Delta — restore-assistant-stream-020

## ADDED Requirements

### Requirement: 流通道合同钉住桥转发的 assistant-stream 帧
dsh-contracts 套件 SHALL 包含一条流通道合同：以慢速流式 dummy LLM 驱动一轮真实回合，断言桥的流转发通知（0.2.0 起 session 格式不再于 session.event 中携带 chunk 事件，活流唯经 `agent/assistant-stream` 通道）逐帧到达宿主——帧词表（start / chunk / end）与 chunk 载荷家族（text-delta、reasoning-delta、usage、finish）形状被钉住；帧 SHALL 按产生它的会话归属路由（多会话并发时不得串扰）；`platform/capabilities` SHALL 播报流转发能力；整轮期间 session.event 通知 SHALL NOT 携带任何 chunk 型增量（防止宿主误把已死通道当活源）。合同失败即候选版本不可跟随。

#### Scenario: 合同捕获帧词表破坏
- **WHEN** 候选 dsh 版本改变 assistant-stream 的帧类型或 chunk 载荷家族（增删类型、字段改名）
- **THEN** 流通道合同 SHALL FAIL 并指认具体差异

#### Scenario: 合同捕获会话串扰
- **WHEN** 流通道合同在两个会话各自流式中核对帧的会话归属
- **THEN** 任何归属错配（A 会话帧标到 B）SHALL 使合同 FAIL

#### Scenario: 合同捕获能力播报缺失
- **WHEN** 桥模板未在 platform/capabilities 中播报流转发能力
- **THEN** 流通道合同 SHALL FAIL（宿主将错误进入降级路径）

#### Scenario: 合同钉住 session.event 无 chunk 的事实
- **WHEN** 候选版本重新在 session.event 中携带 chunk 型增量或恢复 assistant/chunk 事件名
- **THEN** 流通道合同 SHALL FAIL 并如实报告通道形状变化（宿主源绑定需要重新评估，而非静默双源）
