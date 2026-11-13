## ADDED Requirements

### Requirement: 整 run 预算与停车闸

舰队编排 SHALL 可声明整 run 预算 `constraints.runBudget`，含三个互相独立、均可选的维度：`maxTurns`（本 run 允许起的回合数）、`maxTokens`（本 run 累计上报 token 的上限）、`maxMinutes`（自 run 头行开始时刻起的墙钟上限）。未声明 SHALL 表示无上限，行为与引入本条款前一致。写面 SHALL 以结构化错误拒绝非对象、含未知维度、含非正数、或声明了却没有任何有效上限的 `runBudget`；SHALL NOT 把畸形声明静默当作「无上限」。

预算 SHALL 在**边点火**处执行：起火前 SHALL 读取 run 头行与该 run 的回合事实（终态回合取自回合行，另加本 run 仍在排队/执行中的任务），任一维度达上限 SHALL NOT 创建任何下游任务，SHALL 把该上限作为本 run 的停车原因落库，并 SHALL 落一条结构化事实行说明「点火被拒」及其原因；SHALL NOT 静默不点火。

系统 SHALL 提供 run 级停车入口（`POST /:id/runs/:runId/cancel`，仅舰队主人）：SHALL 在 run 头行记录停车时刻与原因，SHALL 中止该 run 在飞回合（经既有中止注册表，落为 interrupted 而非 failed），并 SHALL 使该 run 的一切后续点火被拒。停车 SHALL 幂等——重复调用 SHALL 保留首次原因，SHALL NOT 重复中止。run 收口（status/计数重算）SHALL NOT 清除停车事实。

`constraints.spanMax` SHALL 维持既有 advisory 语义（只告警，不阻断），本条款不改其性质。

#### Scenario: 回合数上限拦下下游

- **WHEN** 某 run 已声明 `maxTurns: 1`，其根回合已执行完毕并触发一条 handoff 边
- **THEN** 该边不创建任务；run 头行的停车原因记录为预算触顶；另有一条事实行说明点火被拒及原因

#### Scenario: 三个维度互相独立

- **WHEN** 某 run 已声明 `maxTokens` 但其回合数与墙钟都远未到上限
- **THEN** 一旦累计 token 达上限即拦下点火；反之 token 未超而回合数超上限时也拦下

#### Scenario: 未声明零变化

- **WHEN** 舰队未声明 `runBudget`
- **THEN** 点火行为与引入本条款前逐字节一致（不新增拦截、不新增事实行）

#### Scenario: 主人取消 run

- **WHEN** 舰队主人对某在飞 run 调用 cancel
- **THEN** 头行记下停车时刻与原因、该 run 在飞回合被中止（落 interrupted）、该 run 后续点火全部被拒

#### Scenario: 取消幂等且不重复中止

- **WHEN** 对同一 run 再次调用 cancel（即使带了不同原因）
- **THEN** 保留首次原因，不再中止第二次，响应如实标注「此前已停车」

#### Scenario: 停车事实不被收口抹掉

- **WHEN** 已停车的 run 随后完成收口重算
- **THEN** 头行的 status/turns 等派生值照常更新，停车时刻与原因保持原值

#### Scenario: 畸形预算拒绝

- **WHEN** 编排声明 `runBudget: 5`、或 `runBudget: {}`、或含未知维度
- **THEN** 写面以结构化错误拒绝并指名问题，声明不落库

#### Scenario: 越权与未知 run

- **WHEN** 非主人或未知 run 调用 cancel
- **THEN** 以与「不存在」一致的方式拒绝，不泄漏他舰队内容
