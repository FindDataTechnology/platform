# skill-self-evolution — Delta

## MODIFIED Requirements

### Requirement: 晋升前过技能 A/B 评测门

候选 SHALL 在晋升前完成技能 A/B 对照评测：同场景任务 prompt、同模型同温、隔离 scratch root
（不触生产数据）、臂名对 judge 匿名——全部沿 `memory-eval` 既有 harness 纪律。臂形状：
无该 skill 对照臂 vs 携该 skill 臂；`supersedes` 候选 SHALL 另含旧 skill 臂（三臂）。
judge 评审输入 SHALL 随附**指导文档真值段**：supersedes 候选的旧 skill 正文与新候选正文以与回答
标签独立的盲标（指导文档一/二）提供，judge 据此核验回答中政策/事实声明的有据性——与任一指导
文档一致的声明 SHALL 视为有据，任何指导文档与任务都不含的声明 SHALL 视为无据（准确性存疑）；
有据性仅服务真值核验，评测质量判据仍为完成任务的程度（正确性、完整性、可执行性）。门判据
SHALL 为：携 skill 臂 judge 盲评不劣于对照臂（supersedes 候选另需不劣于旧 skill 臂），
评测报告（原始 transcript 与 judge 判词）SHALL 随候选存档可查。评测不可用或未跑时候选 SHALL
保持候选态并如实标注「未评测」，MUST NOT 视为通过（判据没跑成≠通过，沿 laneError 分界教训）。

#### Scenario: 候选过门取得证据

- **WHEN** 一个候选完成 A/B 对照且携 skill 臂盲评占优
- **THEN** 候选转「过门」态，评测报告（含臂 transcript 与判词）随候选可查

#### Scenario: 劣化不晋升

- **WHEN** 携 skill 臂盲评劣于对照臂或与旧 skill 臂相比退步
- **THEN** 候选保持候选态并标注评测结论，不进入待确认晋升队列

#### Scenario: 评测没跑成不算过门

- **WHEN** 评测因上游不可达中断
- **THEN** 候选保持候选态并如实标注「未评测（原因）」，接受入口对该候选不可用

#### Scenario: 指导文档真值随判词提供且盲标独立

- **WHEN** 一个 supersedes 候选进入评测，judge 收到评审输入
- **THEN** 评审输入含旧 skill 正文与新候选正文的盲标指导文档段，文档盲标与回答的甲乙丙标签相互独立（judge 无法从标签推断文档与回答的归属）

#### Scenario: 有据声明不再被当臆造

- **WHEN** 携 skill 臂的回答包含其指导文档中明文载有的政策条款，而该条款不在任务文本与对照臂（无指导）的输出中
- **THEN** judge 按有据性规则将该声明判为有据，不因「无从考证」单独否定该回答

#### Scenario: 无据自创声明被判无据

- **WHEN** 任一臂的回答包含任务文本与全部指导文档都不含的政策/事实声明
- **THEN** judge 按有据性规则将该声明判为无据（准确性存疑），该规则对称适用于对照臂
