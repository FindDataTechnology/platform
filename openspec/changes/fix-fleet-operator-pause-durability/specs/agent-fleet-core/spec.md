## ADDED Requirements

### Requirement: 人工暂停与舰队收敛暂停是两层，前者不被后者自动撤销

系统 SHALL 区分两类暂停来源并以任务记录上的 `pausedBy` 字段承载：`"operator"`（主人经队列侧
`POST /api/cron/:id/pause` 发起）与 `"fleet"`（舰队收敛按 `desiredPaused` 发起）。

舰队收敛（`reconcileFleet`）SHALL 在 `desiredPaused` 为假时**不自动恢复** `pausedBy="operator"` 的任务：
该轮 SHALL 保持其暂停态，并在收敛回执中以 `respectedPause` 列出。主人显式 `resumeJob` SHALL 清空
`pausedBy`，此后该任务重新受收敛支配。

`desiredPaused` 为真时（舰队非 active、岗位节奏 disabled、在岗对象不存在），收敛 SHALL 照常暂停并写
`pausedBy="fleet"`——两层暂停方向一致，不存在冲突。

历史记录（无 `pausedBy` 字段）SHALL 按 `"fleet"` 解释，以保持升级前的收敛行为不变。
`pausedBy` SHALL 参与持久化：重启后同一任务仍须判为人工暂停。

#### Scenario: 目录变更不撤销人工暂停

- **WHEN** 主人暂停某舰队成员任务（`pausedBy="operator"`），随后发生一次成功的目录变更并触发 `reconcileAllFleets`
- **THEN** 该任务仍为 `paused=true`、`status=paused`
- **AND** 收敛回执的 `respectedPause` 含该任务 id
- **AND** 该任务的 `nextRun` 不被重新排入待触发

#### Scenario: 主人恢复后收敛重新接管

- **WHEN** 主人对该任务显式 `resumeJob`，随后再次发生目录变更
- **THEN** `pausedBy` 被清空，任务按 `desiredPaused` 正常参与收敛（该恢复为假时不再被暂停/恢复）

#### Scenario: 舰队侧暂停不受影响

- **WHEN** 舰队被置为 `paused`（或岗位 `cadence.enabled=false`、在岗对象失效），收敛算出 `desiredPaused=true`
- **THEN** 任务被暂停且 `pausedBy="fleet"`，`respectedPause` 不含该任务

#### Scenario: 重启后人仍为人工暂停

- **WHEN** 平台重启（cell 重新加载任务）
- **THEN** `pausedBy="operator"` 的任务仍判为人工暂停，收敛不自动恢复它

#### Scenario: 历史记录按舰队层解释

- **WHEN** 一条无 `pausedBy` 字段的旧任务被收敛处理，且 `desiredPaused` 为假
- **THEN** 它按 `pausedBy="fleet"` 处理并被正常恢复（升级不改变既有行为）
