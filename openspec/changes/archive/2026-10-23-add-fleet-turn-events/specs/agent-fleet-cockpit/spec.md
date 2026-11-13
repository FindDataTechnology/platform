# agent-fleet-cockpit Delta — add-fleet-turn-events

## ADDED Requirements

### Requirement: 岗位卡呈现回合成败与连续失败

驾驶舱岗位卡 SHALL 呈现该岗位最近一次回合的结果维度:状态(ok|failed|interrupted)、失败时的原因摘要与 errorKind、结束时刻。成败维度 SHALL 独立于既有派生态徽章(在岗/暂停/失联/待补岗/被动):派生态语义 SHALL 不变,失败岗位不失联时 SHALL 派生态照旧且叠加失败信息。连续失败次数 SHALL 在卡上可读;连续失败达到 3 次(含)以上 SHALL 呈现「连续失败」标记。被动岗以最近一次唤醒回合的结果为准,无任何回合时 SHALL 呈现「尚未执行」而非失败。健康聚合块 SHALL 增加失败维度计数(最近回合失败且在岗的岗位数)。

#### Scenario: 失败原因上卡

- **WHEN** 某在岗岗位最近一次回合失败(errorKind=tool_permission)
- **THEN** 其岗位卡在派生态徽章之外呈现失败状态、原因摘要与 errorKind,并可直达该回合来源会话

#### Scenario: 连续失败标记

- **WHEN** 某岗位连续第 3 次失败
- **THEN** 岗位卡呈现「连续失败」标记;该岗下一次成功后标记消失

#### Scenario: 两维度不合并

- **WHEN** 某岗位既被判失联(超窗未报数)又有最近失败回合
- **THEN** 失联徽章照旧呈现,失败信息独立叠加,不以失败替代失联判定

#### Scenario: 被动岗无回合不判失败

- **WHEN** 一支被动岗自建岗以来从未被唤醒
- **THEN** 其卡呈现「尚未执行」,不呈现失败态

#### Scenario: 健康块失败计数

- **WHEN** 一支 5 岗舰队有 2 岗最近回合失败且在岗
- **THEN** 健康聚合呈现失败维度计数 2,其余计数语义不变
