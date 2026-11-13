## ADDED Requirements

### Requirement: 舰队成员回合预算可按岗位声明

舰队成员岗位（任务携带 fleetId sourceTag）的单回合时长预算 SHALL 可按岗位声明：成员 cadence 的 `turnTimeoutMs` 字段在**界内值 [2 分钟, 30 分钟]** 时 SHALL 生效为该岗位每回合的回合预算（节奏触发、委托唤醒、事件唤醒同一执行缝一致）；越界值 SHALL 取对应界值（钳制，不拒绝、不报错）；未声明或非法值 SHALL 用默认 10 分钟——未声明岗位的系统行为 SHALL 与变更前逐字节一致。预算解析失败（成员行不可读等）SHALL 降级为默认值,SHALL NOT 影响回合启动。普通定时任务（无 fleetId sourceTag）SHALL 不受本字段影响。共享子进程上的凭据交付硬顶语义 SHALL 不变：其「不小于最长单回合预算」口径按本字段声明后的最坏值计。

#### Scenario: 慢上游岗位声明更长预算

- **WHEN** 提案岗 cadence 声明 turnTimeoutMs=1200000（20 分钟），回合内上游车道抖动重试至第 12 分钟仍在推进
- **THEN** 回合按 20 分钟预算继续执行,不出现 10 分钟 turn timed out

#### Scenario: 越界值取界

- **WHEN** 某岗位 cadence 声明 turnTimeoutMs=90000（1.5 分钟,低于下界）
- **THEN** 生效预算为 2 分钟（下界钳制）,回合照常执行

#### Scenario: 未声明岗位行为不变

- **WHEN** 舰队多数岗位未声明 turnTimeoutMs,其中一岗回合推进到第 10 分钟零 1 秒仍未收口
- **THEN** 该回合按既有口径记 turn timed out（默认 10 分钟）,行为与变更前一致

#### Scenario: 普通定时任务不受影响

- **WHEN** 不携带 fleetId sourceTag 的普通定时任务触发
- **THEN** 其回合预算语义与变更前一致（本字段不生效）
