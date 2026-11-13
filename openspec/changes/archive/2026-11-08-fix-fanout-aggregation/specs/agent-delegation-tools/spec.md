## MODIFIED Requirements

### Requirement: Finished fan-outs inject an aggregation turn
When every task delegated in one conversation turn holds a terminal state (done, failed, or interrupted), the system SHALL inject one completion turn into the initiating session prompting its persona to summarize the children's outcomes, including each task's result reference. The injection SHALL queue behind any streaming turn in the cell and SHALL render as a visibly task-authored system turn, not a user bubble. A fan-out with unfinished tasks SHALL NOT inject.

聚合 SHALL 以**一次点火（一波）**为单位，而非以一个会话为单位：同一会话发起的两次扇出 SHALL 各自得到自己的汇总回合，SHALL NOT 合并成一次汇总。分组键 SHALL 在点火时生成并随任务持久化；缺该键的历史任务 SHALL 回落到按发起会话分组（与引入本条款前行为一致）。

汇总回合 SHALL 使用**发起者声明的人格**：提交扇出的岗位 SHALL 把该回合实际所用的人格一并记入其波内任务，聚合器在起汇总回合前 SHALL 据此把发起会话摆回该人格；缺声明时 SHALL 维持既有行为（沿用会话当下的人格），SHALL NOT 因此使汇总失败。

#### Scenario: Aggregation follows the last finisher
- **WHEN** two delegated tasks finish at different times
- **THEN** the aggregation turn is injected only after the later one reaches its terminal state

#### Scenario: Injection waits for a busy turn
- **WHEN** all delegated tasks are finished while a turn is streaming in the cell
- **THEN** the aggregation turn waits for the streaming turn to complete, then is delivered exactly once

#### Scenario: Partial failure still aggregates
- **WHEN** a fan-out ends with one done and one failed task
- **THEN** the aggregation turn names both outcomes, including the failure's gist

#### Scenario: 两波各自汇总
- **WHEN** 同一上游会话先扇出一波任务、随后又扇出第二波，两波先后全部终态
- **THEN** 注入两次汇总回合：第一波只覆盖第一波的任务，第二波只覆盖第二波的任务；两波不合并

#### Scenario: 汇总以发起岗的人格说话
- **WHEN** 主编岗（persona X）扇出给撰稿 A/B 且未声明 judge，全组终态
- **THEN** 汇总回合以 persona X 起，SHALL NOT 沿用扇出留在运行时的最后一个靶岗人格

#### Scenario: 历史任务不重分组
- **WHEN** 升级前入队、无分组键的任务随重启恢复并全部终态
- **THEN** 它们按发起会话聚合为一组并注入一次，与升级前一致
