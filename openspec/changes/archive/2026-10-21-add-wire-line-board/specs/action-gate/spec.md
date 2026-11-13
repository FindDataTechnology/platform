## ADDED Requirements

### Requirement: 柏讯动作注册与风险三方一致

动作注册表 SHALL 登记柏讯八条动作：`wire.demand.submit`（write）、`wire.market.subscribe`（cost）、`wire.market.unsubscribe`（write）、`wire.dataset.create`（write）、`wire.artifact.publish`（write）、`wire.artifact.archive`（write）、`wire.dataset.correct`（write）、`wire.dataset.correction.revert`（write）。动作 id SHALL 与柏讯侧动作闸的登记逐字一致；每条的风险等级 SHALL 与其底层工具在柏讯两个操作 MCP 的工具面声明（`tool_risk`）一致。壹座 SHALL 维护一份该工具面风险声明的本地快照，并以自动化测试断言注册表与快照一致、快照覆盖全部写工具；任一不一致 SHALL 使测试失败并指明条目。柏讯侧存在但未在注册表登记的能力（如删除数据集、草稿创建、转正、对外分享）MUST NOT 经副驾执行。

#### Scenario: 风险漂移被对拍拦住

- **WHEN** 任一柏讯操作 MCP 的工具面把某写工具的风险从 `write` 改为 `cost`，而壹座注册表未同步
- **THEN** 快照刷新后对拍测试失败，输出中指明该工具名、工具面值与注册表值

#### Scenario: 未登记的柏讯动作被拒

- **WHEN** 副驾提议「删除数据集」
- **THEN** 闸以动作未注册拒绝，不调用任何柏讯工具

### Requirement: 柏讯写动作经用户凭据的单一执行路径执行

被批准的柏讯动作 SHALL 经壹座的统一执行路径、以**该用户自己的**柏讯凭据调用对应的操作 MCP 写工具，MUST NOT 使用平台凭据或他人凭据。该用户未连接柏讯凭据时，提议 SHALL 在 preflight 阶段被拦截并给出去连接指引，MUST NOT 进入确认档位。上游以 422 拒绝时，SHALL 将其逐字段错误原样呈现给用户，MUST NOT 改写、补全或代为勾选任何字段。执行中上游返回 401 时，SHALL 清除该用户的柏讯凭据缓存、将该提案标记为执行失败并提示重新授权。每次执行 SHALL 在壹座审计台账留痕，记录 MUST NOT 含凭据明文。

#### Scenario: 未连接时提议被拦截

- **WHEN** 未连接柏讯凭据的用户让副驾提交需求单
- **THEN** preflight 失败，提议不进入确认档位，用户看到「去连接柏讯」指引，未调用任何柏讯工具

#### Scenario: 订阅市场数据集二次确认并展示费用

- **WHEN** 用户让副驾订阅某市场数据集
- **THEN** 确认卡以二次确认档位呈现并显示费用影响面，用户确认后才以其柏讯凭据执行订阅，审计台账新增一条记录

#### Scenario: 上游 422 逐字段呈现

- **WHEN** 已批准的需求单提交被柏讯以 422 拒绝（含字段级错误）
- **THEN** 用户看到的失败原因与柏讯返回的字段级错误逐字一致，提案状态为执行失败，不自动重试

#### Scenario: 执行中凭据失效

- **WHEN** 已批准的柏讯动作在执行时收到上游 401
- **THEN** 该用户的柏讯凭据缓存被清除，提案标记为执行失败并提示重新授权，审计记录保留失败原因

### Requirement: 提议携带真实提议者身份

副驾经 `propose_action` 发起的提议 SHALL 以当前会话用户为提议者落账，使提议随后可被该用户（且仅该用户）批准或拒绝；preflight SHALL 以该用户身份判断线凭据连接态。壹座 SHALL 仅对「创建提议」接受来自本机内部通道的身份声明；批准、拒绝与查询 MUST 经完整的用户认证，MUST NOT 接受内部通道的身份声明。

#### Scenario: 副驾提议后 owner 可批准

- **WHEN** 用户在副驾中让模型提议一个柏讯写动作
- **THEN** 提议以该用户为提议者落账，该用户在确认卡上批准成功，另一用户尝试批准得到 403

#### Scenario: 非本机匿名调用创建提议被拒

- **WHEN** 非本机来源、不带用户认证的请求尝试创建提议
- **THEN** 请求被认证门拒绝，不落任何提议

### Requirement: 执行前用户补填参数且模型值一律丢弃

注册表条目 SHALL 可声明「须由用户亲填」的参数集合。对此类参数，闸在接受提议时 SHALL 丢弃模型提供的任何取值、确认卡 SHALL 以空输入呈现这些字段、全部必填字段填齐前确认操作 MUST 不可用；批准时 SHALL 仅接受声明集合内的键，并以用户填值合并后执行。`wire.demand.submit` 的「公开源 URL」与「公开数据声明」SHALL 属于此集合——壹座 MUST NOT 代填、代勾或采纳模型给出的合规取值。

#### Scenario: 需求单合规字段用户亲填

- **WHEN** 用户让副驾提交需求单
- **THEN** 确认卡含「公开源 URL」「公开数据声明」两个空字段，未填齐时确认钮不可点；填齐并确认后以用户填值执行提交

#### Scenario: 模型给的合规取值被丢弃

- **WHEN** 模型在提议参数中携带了 `source_urls` 与公开数据声明的取值
- **THEN** 确认卡上这两个字段仍为空，落账的提议参数不含模型给出的取值

#### Scenario: 批准携带未声明的键被拒

- **WHEN** 批准请求携带了不在「须由用户亲填」集合内的参数键
- **THEN** 批准被拒绝（400），提案保持待确认状态，不执行

### Requirement: 副驾 pack 不含柏讯写工具

官方「柏讯助手」pack 的工具白名单 SHALL 只含柏讯两个操作 MCP 的读工具；壹座 SHALL 以自动化测试断言官方 pack 的白名单与柏讯工具面声明的全部写工具无交集。使用该 pack 的副驾会话，其可见工具面 SHALL 恰为「pack 读工具 + 平台提供的 `propose_action`」。

#### Scenario: 柏讯助手工具面纯净

- **WHEN** 检查以「柏讯助手」为预设的副驾会话可见工具面
- **THEN** 只含该 pack 声明的柏讯读工具与 `propose_action`，不含任何柏讯写工具

#### Scenario: 向白名单加入写工具被 lint 拦住

- **WHEN** 有人把 `wire_demand_submit` 加入「柏讯助手」的工具白名单
- **THEN** 仓库测试失败并指明该工具名
