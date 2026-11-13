## MODIFIED Requirements

### Requirement: L2 写入纪律——永不删页、只 supersede、脱敏、预算内

蒸馏产物 SHALL 以新页写入（fact / experience 页型），当产物是对既有条目的修正时 MUST 写新页并携带 `supersedes[]` 指向被修正页，被修正页保持原样（历史可溯）；蒸馏 MUST NOT 删除或改写任何既有页。**事实层与经验层同纪律**：fact 草稿经事实层 reconcile 关联到既有 fact 时 MUST 以 supersedes 合并（一条新页可并列指向多条被并的旧页），无关联才新增；单次蒸馏的 fact 产出 MUST 受上限约束（超出丢弃并记审计 warning），抑制薄记录累积。产物正文与 `details`（原文直取，上限 4000 字符）MUST 过既有四类脱敏后才落盘；`sources[]` MUST 引用产出它的 item 坐标。蒸馏失败、超限或引擎不可达 MUST NOT 阻塞 L0 capture / L1 交接 / MCP 面——L2 是纯后台车道。

#### Scenario: 修正以 supersede 表达

- **WHEN** 引擎对既有经验 E1 判 UPDATE，产出新经验 E2
- **THEN** E2 写入并携带 supersedes 指向 E1，E1 仍在原处且内容未变

#### Scenario: 事实层合并同主体薄记录

- **WHEN** 一段新会话产出的 fact 草稿经 reconcile 关联到既有 fact F1（同主体）
- **THEN** 落一条新 fact 页携带 supersedes 指向 F1，F1 原样保留；该批不再额外新增无关联 fact 超出上限

#### Scenario: 薄 fact 限流可审计

- **WHEN** 单次蒸馏的 fact 草稿超过上限
- **THEN** 仅保留上限内的条目，超出部分以 llm_calls 审计 warning 记录，无静默丢弃

#### Scenario: L2 停摆不影响 L0/L1

- **WHEN** 蒸馏 sidecar 不可达或预算耗尽
- **THEN** capture、交接、查询全部照常，缺口被记录，恢复后从原 cursor 续跑

#### Scenario: 产物脱敏

- **WHEN** 会话观测里含密钥类内容并被蒸馏
- **THEN** 落盘的 fact / experience 页面正文与 details 均为脱敏后文本

## ADDED Requirements

### Requirement: subject 覆盖判定走规范化等值与语义判定双路

事实层 reconcile 的主体覆盖判定 SHALL 先经规范化等值（大小写、空白、全半角、首尾标点归一）——机器标识符类 subject 在此路即判同；不等时 SHALL 经同一车道的一次结构化 LLM 判定（提示词以边界补丁注入，判定结果可从 llm_calls 审计还原）；两路都不过才判为不同主体。判定 MUST 只影响 reconcile 的归并决策，MUST NOT 改写产物的 subject 字段。

#### Scenario: 机器标识符走等值路

- **WHEN** 两个 subject 仅为大小写或空白差异（如路径、域名、邮箱）
- **THEN** 规范化后判同主体，不发起 LLM 判定调用

#### Scenario: 中文短语漂移走语义判定

- **WHEN** 两个 subject 指同一实体但措辞不同（S1 原例：`cheap-2 deploy/agent-api` vs `cheap-2 上的 deploy/agent-api (namespace serving)`）
- **THEN** LLM 判定判同主体，reconcile 归并为一条 supersede 链

#### Scenario: 判定不改写产物

- **WHEN** 语义判定把两个 subject 判同
- **THEN** 新页保留引擎原产出的 subject 字符串，supersedes 指向旧页
