## ADDED Requirements

### Requirement: Release-line CI queues runs instead of cancelling them

出片车间的 CI SHALL 对同一 ref 采取**串行排队**，不得用 `cancel-in-progress` 顶掉正在运行的一轮。

判据是这条 CI 的时长结构：单测真跑约 26 分钟，而工作区允许多个会话并行开发、各自出片。在这个组合下"后推顶掉前推"意味着**先开始的那一次几乎必定跑不完**——它不是在节省资源，而是在让出片不可用，并且每次都实烧一轮额度。

- 同一 ref 的多次推送 SHALL 排队，后来的等待前面的结束，而不是取消它。
- 不同 ref 之间 MAY 并行（并发组按 ref 划分）。
- 一次被取消的运行 SHALL NOT 被当作失败计入结论，但**取消本身不得成为常态**：如果同一 ref 上出现连续取消，那是并发策略问题的信号，而不是某次推送的运气不好。
- 排队状态 SHALL 对推送者可见（`queued` 与 `in_progress` 可区分），使"我的片在等"与"我的片在跑"不会混淆。

#### Scenario: a second push waits for the first run

- **WHEN** 同一 ref 上已有一轮出片 CI 在运行，此时又推一次
- **THEN** 新的运行 SHALL 进入 `queued`
- **AND** 正在运行的那一轮 SHALL NOT 被取消
- **AND** 只有它结束后，排在后面的那一轮才开始

#### Scenario: a long unit-test step completes

- **WHEN** 一轮运行进入单测步骤并需要超过 20 分钟
- **THEN** 该步骤 SHALL 跑到结束（通过或失败），不因新推送而中断

#### Scenario: cancellation is treated as a signal, not as noise

- **WHEN** 同一 ref 上出现连续多轮被取消的运行
- **THEN** 这 SHALL 被视为并发策略配置问题（需要排队而非取消），而不是个别推送的失败
