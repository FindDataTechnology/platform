# matter-threads Specification

## Purpose

事项串：跨方沟通的耐久锚点。v1 落在分身（principal facade）的 escalation 出口——接待
角色遇到越界问题（价格/合同/对外承诺）或访客要求预约真人时，把问题结构化为一个事项：
落进分身主人的队列，主人回应/关闭，访客经对话读进展。「事项」是 agents-native 沟通的
第二块地址原语（第一块=分身）。

## Requirements

### Requirement: 事项对象与开串

事项 SHALL 为平台侧对象，归属一个分身部署（pack+agent）。接待角色可经其工具面开事项：
携带事项摘要（访客的问题与必要上下文）与访客线索；平台生成不可预测的 `mt_` 标识并置
初始状态「待回应」。非 facade 部署的 child 工具面 SHALL NOT 出现事项工具。

#### Scenario: 接待开串成功

- **WHEN** facade 部署的接待角色调用开串工具，携带摘要
- **THEN** 平台落一个待回应事项（mt_ 标识、所属部署、时间线首条），返回标识

#### Scenario: 非 facade 部署无此工具

- **WHEN** 一个不带 facade 声明的部署 materialize
- **THEN** 其 child 工具面不包含任何事项工具

#### Scenario: 开串触发主人通知

- **WHEN** 事项开串且该部署绑定了通知渠道
- **THEN** 既有通知中继送出一条例外摘要通知（既有渠道限速与审计全适用）

### Requirement: 主人队列与回应

分身主人（部署者）SHALL 能在包详情的分身面板下看到该部署的事项清单（待回应优先），并
对事项**回应**（文本追加时间线，状态流转为「已回应」）或**关闭**（置「已关闭」，可附
关闭说明）。回应与关闭 SHALL 留审计行（谁、何时），事项正文 SHALL NOT 进日志。

#### Scenario: 主人回应流转状态

- **WHEN** 主人对一个待回应事项提交回应
- **THEN** 时间线追加回应条目，状态流转为已回应，待回应清单减一

#### Scenario: 主人关闭附说明

- **WHEN** 主人关闭一个事项并附说明
- **THEN** 状态置已关闭，时间线含关闭条目与说明

### Requirement: 访客经对话读进展

访客 SHALL 经与接待的对话读事项进展：接待的状态工具返回该部署的事项列表（标识/摘要/
状态/最近活动），读取工具返回单事项时间线含主人回应。child 侧 SHALL 只报事件——开串/
读取的策略（限速、出站凭据、目标路由）全在 runner；事项内容 SHALL NOT 出现在 runner
审计日志。

#### Scenario: 访客问进展

- **WHEN** 访客在对话中询问其事项进展，接待调用状态工具
- **THEN** 接待获得该部署的事项清单（含主人已回应的内容），如实转述

#### Scenario: 开串限速

- **WHEN** 单一部署的接待在短窗内高频开串
- **THEN** runner 侧限速拒绝超额开串，既有对话不受影响

### Requirement: 平台路由与鉴权分层

runner 侧事项调用 SHALL 走 facet internal 路由并以部署服务凭据鉴权（host-settle 同型）；
主人侧队列/回应/关闭 SHALL 走登录态路由且仅部署者（或管理组）可见。未凭据 internal
调用 SHALL 拒绝；非本人事项 SHALL 404（不泄露存在性）。

#### Scenario: 无凭据 internal 拒绝

- **WHEN** 不带服务凭据调用事项 internal 路由
- **THEN** 401 拒绝

#### Scenario: 非主人不可见

- **WHEN** 一个非部署者用户请求该部署的事项清单
- **THEN** 与不存在同形（404），不泄露事项存在性

### Requirement: 事项的访客可见边界

开事项时 SHALL 以调用方访客会话派生的不透明 scope key 绑定该事项（`scope_key`）。
接待工具面的 list/read SHALL 按调用方会话过滤：仅返回**本会话绑定**与**无界存量**
（scope 为空）的事项；异会访客的事项 SHALL NOT 经工具面可见，其存在性 SHALL NOT
泄露。主人队列（部署者/管理组）SHALL 全量可见不受 scope 影响。存量无 scope 事项
SHALL 保持对全部访客可见（兼容 v1）。无会话上下文的开串 SHALL 落为无界并留审计行。

#### Scenario: 异会访客不可见

- **WHEN** 访客 A 开了事项，访客 B（不同会话）让接待列事项
- **THEN** B 的事项清单不含 A 的事项，读取 A 的事项号返回同形不存在

#### Scenario: 同会访客可见

- **WHEN** 开串的同一会话内访客随后查询状态与时间线
- **THEN** 该事项可见且可读（含主人回应）

#### Scenario: 主人全见

- **WHEN** 部署者打开包详情的队列
- **THEN** 全部事项（含各 scope）按现状全量呈现
