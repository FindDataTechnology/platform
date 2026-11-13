## Purpose

把包声明的外部系统需求（`connector_bindings`）兑现成每用户可执行的窄面授权：包说「我要金蝶读写、支付渠道只读」，平台据此解析到该用户连接器里的具体连接、铸一枚范围令牌并按绑定注入会话，未满足时如实报缺而不是假装接通。

## ADDED Requirements

### Requirement: 绑定声明是机器字段

包的 `connector_bindings` SHALL 为每个条目提供机器可读的绑定契约，至少包含：`key`（包内唯一）、`provider`（连接器目录 service id）、授权单元 `allowOperations`（`{provider, operationType}` 列表，operationType 取自目录的读/写分类）或更精确的 `allowActions`、可选 `connectionHint`（期望的连接名提示，不参与校验）、`optional`（布尔）与 `alternativeProviders`（可替代 service id 列表）。

人读字段 `external_system`、`surface`、`direction`、`credential`、`note` 保留，但 SHALL NOT 参与任何校验或解析判定。

校验 SHALL 拒绝：`key` 在包内重复、`provider` 为空、`allowOperations` 与 `allowActions` 同时缺失（无法界定范围）、`operationType` 不在闭集内。声明非法的包 SHALL NOT 进入安装流程。

#### Scenario: 合法声明被接受

- **WHEN** 包的某条绑定含 `key`、`provider` 与 `allowOperations`
- **THEN** 包通过声明校验，该绑定成为可解析条目

#### Scenario: 无范围声明被拒

- **WHEN** 某条绑定只有 `external_system` 与人读描述、既无 `allowOperations` 也无 `allowActions`
- **THEN** 包被拒收并指明该绑定无法界定范围；不以「默认全权」兜底

#### Scenario: 重复 key 被拒

- **WHEN** 同一包内两条绑定使用相同 `key`
- **THEN** 包被拒收并指明冲突的 key

#### Scenario: 单一 provider 多绑定

- **WHEN** 同一包对同一 `provider` 声明两条范围不同的绑定（如只读与写入各一）
- **THEN** 两条各自独立解析与授权，不互相合并

### Requirement: 绑定台账与四态解析

平台 SHALL 按 `(用户, 包, 绑定 key)` 维护绑定台账，每行记录解析到的连接器连接 id、解析时间与状态。状态闭集为 `satisfied`、`missing`、`stale`、`unwired`、`undetermined`、`deprecated`，语义固定：

- `satisfied`：provider 在目录内、用户持有满足该绑定的连接、目录动作面覆盖声明范围；
- `missing`：用户尚未建立该 provider 的连接；
- `stale`：曾有连接但凭证已失效（连接器侧撤销或工具调用 401）；
- `unwired`：provider 不在目录，或目录动作面**不足以覆盖**声明范围（如声明的写面在目录中只有只读动作）；
- `undetermined`：自省面没能给出答案（连接器不可达、超时、5xx、响应畸形，或本部署未配置连接器）。「问不到」既不是能力缺口也不是用户未配置；
- `deprecated`：包的新版本不再声明该 key（台账保留、令牌不动，因为静默吊销会打断正在运行的会话）。

`unwired` SHALL NOT 退化为 `missing`——前者是产品能力缺口，后者是用户未配置，两者的修复路径不同。`undetermined` SHALL NOT 退化为 `unwired` 或 `missing`——把一次故障说成「你的产品不支持」或「你还没连」，是在另一个方向上撒谎。

`undetermined` 与 `deprecated` 都 SHALL NOT 阻止包安装，也 SHALL NOT 计入「待处理」；`deprecated` 行 SHALL NOT 出现在状态面（它是历史，不是需求），其令牌 SHALL 保留。

解析 SHALL 幂等：同一输入重复解析产生同一状态，不产生重复行、不改动已授权令牌。

#### Scenario: 四态各自成立

- **WHEN** 分别构造「连接齐备」「未建连接」「凭证被撤销」「目录缺动作面」四种情形后解析绑定
- **THEN** 台账分别报 `satisfied`、`missing`、`stale`、`unwired`

#### Scenario: 目录不足以覆盖声明范围

- **WHEN** 某绑定声明 `provider=kingdee` 且要求写入发票，而目录中该 provider 只有通用只读动作
- **THEN** 该绑定报 `unwired` 并指明缺失的操作类；不报 `missing`，也不铸令牌

#### Scenario: 问不到时不冒充答案

- **WHEN** 解析某绑定时连接器自省面不可达（超时、连接被拒、5xx）
- **THEN** 该绑定报 `undetermined`；不报 `unwired`，也不报 `missing`，且不因此阻止包安装

#### Scenario: 解析幂等

- **WHEN** 对同一用户同一包连续解析两次
- **THEN** 台账行数与状态不变，已授权令牌不被重铸

### Requirement: 安装与启用门

包在安装或激活时 SHALL 逐条解析其 `connector_bindings`。存在未解决的**非 optional** 绑定时，平台 SHALL NOT 将包标记为「已接通」：界面须把该包呈现为「待连接」，并列出未满足绑定与逐条修复入口（去连接 / 去授权）。

全部可解析的声明绑定 SHALL 经**一个**授权弹窗一次授予（声明式授权），弹窗逐条列出「包需要什么」（provider、读/写、连接名提示）；用户确认后平台一次性为各绑定铸范围令牌，不要求逐条点选。

`optional` 绑定未满足 SHALL 只降级该绑定并在状态面标注，MUST NOT 阻止包安装。

#### Scenario: 非 optional 未满足则待连接

- **WHEN** 安装一个含非 optional 绑定且用户无对应连接的包
- **THEN** 包呈现为待连接并列出未满足项，不显示为已接通

#### Scenario: 一次弹窗授予全部声明

- **WHEN** 用户确认该弹窗
- **THEN** 所有已解析的绑定各自铸得范围令牌，不出现逐绑定二次确认

#### Scenario: optional 未满足只降级

- **WHEN** 某 optional 绑定无法解析而其余绑定可解析
- **THEN** 包照常安装，状态面标注该 optional 绑定未满足

#### Scenario: 声明范围不可全部兑现

- **WHEN** 包内某绑定为 `unwired`
- **THEN** 包不得因该绑定而谎称能力齐备；弹窗与状态面须如实显示该 provider 的能力缺口

### Requirement: 按绑定注入与单轨替换

会话的有效 profile SHALL 按**绑定**注入连接器 MCP 服务行，每行名称以绑定为标识（`connector:<packId>:<bindingKey>`），携带该绑定独有的范围令牌。全局单一 `connector` 行 SHALL 退役。

行名带 `packId` 是必要的：两个包可以声明同一个 `bindingKey`（都叫 `kingdee-cloud`），而 401 只能看到行名——只有包前缀能让一次失败归因到唯一一条绑定，否则一条失效会把两条一起划掉。

同一用户的多条绑定 SHALL 各自独立注入：某条绑定失效只影响该行，其他绑定的服务行保持可用，MUST NOT 因一条失效而整体移除连接器能力。

未设置范围的全权令牌 SHALL NOT 被自动注入任何绑定行——注入必须对应一条已授权绑定。

#### Scenario: 多绑定多行注入

- **WHEN** 用户持有两个已授权绑定
- **THEN** 有效 profile 中出现两行 `connector:<packId>:<bindingKey>`，各自 Authorization 不同

#### Scenario: 单行失效不牵连

- **WHEN** 其中一条绑定的令牌被撤销或翻 stale
- **THEN** 该行从有效 profile 省略并重应用一次，另一行保持注入

#### Scenario: 全局行退役

- **WHEN** 任一会话写入有效 profile
- **THEN** 不再出现无绑定的全局 `connector` 行；能力一律经绑定获得

#### Scenario: 无身份部署保留机器主人行

- **WHEN** 部署关闭了身份（`TENANCY=off`，会话没有 owner 可以归属绑定）
- **THEN** 保留改动前的那一行 `connector`（行为与升级前逐字节一致），因为此时没有任何用户可按绑定授权；一旦存在身份，全局行一律退役

#### Scenario: 全权令牌不自动注入

- **WHEN** 用户仅持有一枚全权 PAT 而没有任何已授权绑定
- **THEN** 不注入任何连接器服务行，聊天车道从空范围起步

### Requirement: 渐进授权

当会话中的连接器工具调用因**范围不足**被拒时，平台 SHALL 将其归类为「范围不足」而非「凭据失效」，并把授权入口挂在失败块上，指明所需 provider 与操作类（读/写）。

用户在该入口确认后，平台 SHALL 重铸该绑定的范围令牌（范围并入，旧令牌吊销）并在**下一轮**生效；平台 MUST NOT 自动重试被拒的调用（写操作尤其），也 MUST NOT 在用户未确认时扩大范围。

授权粒度 SHALL 为 `(provider, operationType)`；同一 provider 同一类操作只授予一次，不逐动作弹窗。

#### Scenario: 范围不足出授权卡

- **WHEN** 聊天车道执行某动作返回范围不足（`action_not_allowed`）
- **THEN** 失败块呈现「去授权：<provider> · <读/写>」入口，且不呈现为凭据失效

#### Scenario: 授权后下一轮生效

- **WHEN** 用户确认该授权入口
- **THEN** 该绑定令牌被重铸为包含该操作类，旧令牌失效；下一次调用成功

#### Scenario: 不自动重试

- **WHEN** 用户确认授权的动作是一次写操作
- **THEN** 平台不自动重放原调用，由用户或模型在下一轮显式重新发起

#### Scenario: 同类操作只授一次

- **WHEN** 用户已授权某 provider 的读操作，随后另一读动作在同一绑定上被拒
- **THEN** 不再次弹窗（该操作类已在范围内），行为与授权后一致

### Requirement: 绑定授权可撤销且失效可见

用户 SHALL 能撤销任一绑定的授权：撤销后该绑定的令牌在连接器侧被吊销、服务行从有效 profile 省略、台账回到 `missing`（若连接仍在）或保持 `stale`（若连接亦失效）。

连接器侧令牌失效（401）SHALL 把对应绑定标为 `stale` 并把行从有效 profile 省略，状态面须提示「重连/重新授权」，MUST NOT 自动改选其他连接或绑定。

#### Scenario: 撤销绑定授权

- **WHEN** 用户撤销某绑定授权
- **THEN** 该绑定的连接器令牌被吊销，服务行消失，台账状态如实回落

#### Scenario: 令牌失效翻 stale

- **WHEN** 某绑定的令牌在连接器侧被撤销后该行工具调用返回 401
- **THEN** 该绑定标记 `stale`、行被省略、状态面提示重新授权；其他绑定不受影响

#### Scenario: 不自动改选

- **WHEN** 某绑定的连接被删除
- **THEN** 平台不自动改用同 provider 的其他连接，状态回到 `missing` 等用户显式选择

### Requirement: 存量单账号平滑迁移

已持有单一连接器凭据的用户 SHALL 平滑迁移为「主账号 + 一条内置自由探索绑定」：主账号作为凭证来源，内置绑定保留本次变更前的行为（按用户显式授予的全权），并在状态面**显式**呈现为已授权条目。

迁移 MUST NOT 丢失既有账号、既有 PAT 或既有连接；若历史数据存在多个账号而「活跃账号」为唯一注入来源，迁移 SHALL 以原活跃账号为主账号，其余账号保留为备用凭证来源且不自动获得授权。

#### Scenario: 单账号用户迁移

- **WHEN** 持有单账号且该账号活跃的用户升级后打开设置
- **THEN** 出现主账号与一条内置自由探索绑定，其能力与升级前一致

#### Scenario: 多账号不自动授权

- **WHEN** 历史数据含多个账号、其中原活跃账号为主账号
- **THEN** 其余账号保留为可选凭证来源，但不自动获得任何绑定授权

#### Scenario: 迁移不丢凭证

- **WHEN** 迁移完成后检查凭据状态
- **THEN** 既有连接与账号仍在，未因迁移产生断连
