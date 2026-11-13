## MODIFIED Requirements

### Requirement: 需求驱动的唤醒与挂起

执行体 SHALL 按需求绑定与解绑 cell：已验证用户流量立即拉起；`suspended`/`on_demand`
cell 的持久化任务时刻表到期 SHALL 唤醒 cell 履约。时刻表覆盖三类调度形态：cron 表达式
任务按表达式到期；interval 循环任务按锚点加周期的下次出现点到期（与 cron-module 的
interval 语义同口径）；未来触发的 one-shot 任务按其目标时刻判定——one-shot SHALL 提前
保持可唤醒（引擎 boot 会把已过点的 one-shot 标记 expired，事后唤醒无从履约）。跑满
run-count 的任务 SHALL NOT 参与唤醒；paused 任务 SHALL NOT 参与唤醒（既有语义）。
静默期（无流量且无在跑任务）后 SHALL 排干挂起。唤醒判决 SHALL 只读持久化数据
（注册表与数据根的任务记录），不依赖 cell 进程是否存在。唤醒后紧邻冷启动的运行时未就
绪窗口 SHALL 由 cell 内的就绪等待语义吸收；吸收失败按未执行如实记录，不得制造假成功。

#### Scenario: 定时到期唤醒履约再挂起

- **WHEN** 一个 `suspended` cell 的持久化时刻表到达到期点
- **THEN** 执行体拉起该 cell，其任务引擎按既有规则履约（含停机补跑），静默期后再次挂起

#### Scenario: 纯 interval 任务的 cell 到期唤醒

- **WHEN** 一个 `suspended` cell 只持有 interval 循环任务（无 cron 表达式）且其下次出现点已到
- **THEN** 值班环 SHALL 唤醒该 cell 履约，而不是因「无 cron 表达式」静默跳过

#### Scenario: 未来 one-shot 任务提前可唤醒

- **WHEN** 一个 `on_demand` cell 只持有一个未来触发的 one-shot 任务
- **THEN** 该 cell SHALL 在可运行状态以等待触发时刻，而不是被回收后错过履约

#### Scenario: 跑满与暂停的任务不参与唤醒

- **WHEN** 一个 cell 的任务全部跑满 run-count 或处于 paused
- **THEN** 值班环 SHALL NOT 因它们唤醒该 cell

#### Scenario: 唤醒判决零进程依赖

- **WHEN** 执行体的值班环评估一个无进程的 `suspended` cell 是否到期
- **THEN** 判决完全来自注册表与数据根的持久化时刻表，不需要也不尝试拉起该 cell 来询问
