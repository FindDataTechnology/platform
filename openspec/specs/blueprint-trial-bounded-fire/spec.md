## Purpose

试跑的点火步骤必须有时间边界：单个 cron 作业点火悬挂不得占死试跑锁或拖死整场试跑——超时如实入档（fired 行带 error），试跑继续按既有窗口收证判红。

## Requirements

### Requirement: 点火必须有界，超时如实入档

fireRound 对每个作业的点火必须（SHALL）与超时窗竞速；超时的作业必须（SHALL）在 fired 中带 error 如实记录，试跑流程继续收证，锁必须（SHALL）在试跑返回时释放（既有 finally 语义）。

#### Scenario: 作业点火悬挂不拖死试跑
- **WHEN** 某 cron 作业的 runJobNow 超过点火超时窗未返回
- **THEN** fireRound 在窗内返回，该作业 fired 行带 fire timeout 错误，试跑继续收证并按窗口出判
