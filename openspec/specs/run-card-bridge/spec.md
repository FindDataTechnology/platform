# run-card-bridge Specification

## Purpose
把 task-flow 卡片与 `run-card/1` 之间的往返固定成一份可复算的契约：导出不丢，导入不造第二条任务记录，判据与裁定仍由 task-flow 解释。

## Requirements

### Requirement: 卡片可导出为 Run Card 且往返无损

系统 MUST 能把一张 task-flow 卡片导出为 `run-card/1`，再导入回同一标识的任务。往返后 MUST 保持：任务标识、流程归属（flowId / stationId / sortKey）、当前判据、历史执行记录、最近裁定。MUST NOT 产生第二条任务记录，MUST NOT 改写既有执行历史。

#### Scenario: 有历史的卡片往返

- **WHEN** 一张已有三次执行历史与一次裁定的卡片被导出、再导入
- **THEN** 标识、流程归属、判据、执行历史与裁定逐字段相等
- **AND** 任务记录总数不变

#### Scenario: 缺截止时间的卡片不被伪造

- **WHEN** 导出一张没有截止时间的卡片且调用方没有提供 `deadline`
- **THEN** 导出被拒绝并指名缺失字段，不生成一个默认截止时间

### Requirement: 信封不内嵌执行者地址

Run Card MUST NOT 内嵌会话 id、平台内部句柄或执行者地址。流程归属与执行历史 MAY 作为不解释的透传块携带，但其语义 MUST 只由 task-flow 解释，MUST NOT 被桥接层重新判定。

#### Scenario: 不携带会话句柄

- **WHEN** 导出一张已绑定会话的卡片
- **THEN** 导出的信封不含会话 id
- **AND** 导入后原会话仍由 task-flow 侧按原归属解析

### Requirement: 判据词表只有一份

桥接层 MUST NOT 定义新的判据语义或求值实现。导入时 MUST 使用 `task-flow` 的既有校验与求值；未知 kind MUST fail closed，MUST NOT 被当作通过。

#### Scenario: 未知 kind 被拒

- **WHEN** 导入的信封含一个 `task-flow` 词表外的 kind
- **THEN** 导入被拒绝并列出合法取值
- **AND** 不产生部分写入
