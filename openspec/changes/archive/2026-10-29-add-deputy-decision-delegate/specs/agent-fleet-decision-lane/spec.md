## MODIFIED Requirements

### Requirement: 成员岗位可提交结构化拍板项

系统 SHALL 向舰队成员的回合提供 `escalate` 工具：入参为问题文本、选项数组（每项含值与人读标签）、严重度、可选建议时限（仅展示，不触发过期）、可选建议选项与可选类别；一次调用 SHALL 落一条拍板项，携带来源岗位、来源回合会话与提交时刻，并按当次生效委托策略同步设定路由（owner 或 deputy）。非舰队成员调用 SHALL 以结构化错误拒绝；每岗位每日提交数与舰队级队列容量 SHALL 有上限，超限以结构化错误拒绝。落库前系统 SHALL 执行归并检查：同来源岗位、近 N 天（默认 7 天）内语义相似的 open 条目存在时，新提交 SHALL 关联既有条目而不产生新行，并向提交方返回既有条目引用；归并 SHALL NOT 跨岗位。

#### Scenario: 岗位提交拍板

- **WHEN** 「内容部」岗位回合调用 escalate 提交 {question:"本周视频是否提前发布", options:[立即发布, 周五发布], severity:high, suggestedDeadline:"48 小时内"}
- **THEN** 拍板项落队列，按委托策略设定路由，管理面对应队列可见其问题/选项/严重度/建议时限/来源岗位与会话链接

#### Scenario: 队列防洪

- **WHEN** 某岗位当日提交数达到上限后再次调用 escalate
- **THEN** 该次调用以结构化错误拒绝且不落库，既有队列不受影响

#### Scenario: 重复升级归并到既有项

- **WHEN** 同一岗位近 7 天内已有语义相似的 open 条目，再次 escalate 同一主题
- **THEN** 不产生新行，既有条目关联本次升级（升级次数 +1），返回值指回既有条目

#### Scenario: 不同问题正常落行

- **WHEN** 同一岗位提交与近 7 天条目均不相似的新问题
- **THEN** 正常落新行并按委托策略路由

### Requirement: 超时过期与通知

拍板项的过期 SHALL 由**舰队级策略**决定（默认 72 小时未裁自动转 expired，策略可调或整体关闭），而非由岗位提交方设定——岗位提交的建议时限 SHALL 仅作展示。expired 项 SHALL 保留在列表不静默消失，可由主人重开。过期清扫 SHALL 同时覆盖 route=owner 与 route=deputy 的 open 条目。队列出现新的 open 项 SHALL 按既有通知契约产生未读标记；「等你 N 件」应用入口徽章 SHALL 只计 route=owner 的 open 项（route=deputy 的计入常务岗队列视图），并 MAY 经微信订阅信封 best-effort 提醒。

#### Scenario: 策略过期

- **WHEN** 舰队过期策略为默认 72 小时，一条拍板项 72 小时未裁
- **THEN** 该项自动转 expired 留在列表可见，徽章计数不再包含它

#### Scenario: 徽章随未决派生

- **WHEN** 66 条 open 中 40 条路由 deputy 且尚未裁决
- **THEN** 「等你 N 件」徽章计 26（route=owner），deputy 队列视图计 40

#### Scenario: 建议时限不触发过期

- **WHEN** 岗位提交时附「建议 24 小时内裁」，而舰队策略为 72 小时或已关闭
- **THEN** 该项仅展示建议时限，过期行为完全跟随舰队策略