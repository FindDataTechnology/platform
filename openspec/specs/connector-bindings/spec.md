# connector-bindings Specification

## Purpose
把包声明的外部系统需求（`connector_bindings`）兑现成每用户可执行的窄面授权：包说「我要金蝶读写、支付渠道只读」，平台据此解析到该用户连接器里的具体连接、铸一枚范围令牌并按绑定注入会话，未满足时如实报缺而不是假装接通。

## Requirements

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

> 标题沿用历史名（原为四态）；状态闭集现为七个，本变更新增 `unmapped`。

平台 SHALL 按 `(用户, 包, 绑定 key)` 维护绑定台账，每行记录解析到的连接器连接 id、解析时间与状态。状态闭集为 `satisfied`、`missing`、`stale`、`unwired`、`unmapped`、`undetermined`、`deprecated`，语义固定：

- `satisfied`：provider 在目录内、用户持有满足该绑定的连接、目录动作面覆盖声明范围；
- `missing`：用户尚未建立该 provider 的连接；
- `stale`：曾有连接但凭证已失效（连接器侧撤销或工具调用 401）；
- `unwired`：provider 不在目录，或目录动作面**不足以覆盖**声明范围（如声明的写面在目录中只有只读动作）；
- `unmapped`：该绑定以角色形态声明（`providerRole: true`），而用户尚未为这个角色选定实际系统。既不是能力缺口，也不是「已选但没连」——用户可自行闭环；
- `undetermined`：自省面没能给出答案（连接器不可达、超时、5xx、响应畸形，或本部署未配置连接器）。「问不到」既不是能力缺口也不是用户未配置；
- `deprecated`：包的新版本不再声明该 key（台账保留、令牌不动，因为静默吊销会打断正在运行的会话）。

`unwired` SHALL NOT 退化为 `missing`——前者是产品能力缺口，后者是用户未配置，两者的修复路径不同。`unmapped` SHALL NOT 退化为 `unwired` 或 `missing`，反向亦然：把「还没选系统」说成「产品不支持」或「你还没连」，会把用户导向错误的修复动作。`undetermined` SHALL NOT 退化为 `unwired` 或 `missing`——把一次故障说成「你的产品不支持」或「你还没连」，是在另一个方向上撒谎。

`undetermined` 与 `deprecated` 都 SHALL NOT 阻止包安装，也 SHALL NOT 计入「待处理」；`deprecated` 行 SHALL NOT 出现在状态面（它是历史，不是需求），其令牌 SHALL 保留。`unmapped` 与 `missing`、`stale`、`unwired` 一样计入「待处理」，且 SHALL 在状态面的汇总里单独计数，不与 `unwired` 合并。

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

#### Scenario: 未映射不被说成能力缺口

- **WHEN** 某角色绑定尚未选定系统
- **THEN** 台账报 `unmapped`，不报 `unwired`；状态面汇总里 `unmapped` 单独计数

#### Scenario: 解析幂等

- **WHEN** 对同一用户同一包连续解析两次
- **THEN** 台账行数与状态不变，已授权令牌不被重铸

### Requirement: 安装与启用门

包在安装或激活时 SHALL 逐条解析其 `connector_bindings`。存在未解决的**非 optional** 绑定时，平台 SHALL NOT 将包标记为「已接通」：界面须把该包呈现为「待连接」，并列出未满足绑定与逐条修复入口（去连接 / 去授权 / 选择系统）。

全部可解析的声明绑定 SHALL 经**一个**授权弹窗一次授予（声明式授权），弹窗逐条列出「包需要什么」（provider 或角色及其已选系统、读/写、连接名提示）；用户确认后平台一次性为各绑定铸范围令牌，不要求逐条点选。

未映射的角色绑定 SHALL NOT 进入该授权弹窗的可授予集合：没有目标 provider 就没有可界定的范围，先把系统选定，再并入同一弹窗授予。

`optional` 绑定未满足 SHALL 只降级该绑定并在状态面标注，MUST NOT 阻止包安装。

#### Scenario: 非 optional 未满足则待连接

- **WHEN** 安装一个含非 optional 绑定且用户无对应连接的包
- **THEN** 包呈现为待连接并列出未满足项，不显示为已接通

#### Scenario: 一次弹窗授予全部声明

- **WHEN** 用户确认该弹窗
- **THEN** 所有已解析的绑定各自铸得范围令牌，不出现逐绑定二次确认

#### Scenario: 未映射不进入授予集合

- **WHEN** 某包同时含一条已映射角色绑定与一条未映射角色绑定
- **THEN** 弹窗只列出已映射的那条并为其铸令牌；未映射的那条以「选择系统」入口列在待连接项里

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

### Requirement: 角色绑定经映射解析

以角色形态声明的绑定 SHALL 先取其映射，再按映射到的 provider 走既有解析路径（目录覆盖 → 连接存在 → 选取连接）。

无映射时该绑定 SHALL 报 `unmapped`，平台 MUST NOT 用角色名本身去查目录（那必然得到「未知 provider」，把一个未回答的问题伪装成能力缺口）。有映射时平台 MUST NOT 在映射到的 provider 覆盖不足或连接缺失时静默改用 `alternativeProviders` 或其他候选——映射是用户的选择，替用户改选会让状态面与用户认知分叉；此时 SHALL 报 `unwired`（覆盖不足，指明缺口操作类）或 `missing`（无该连接），并在状态面提供改选入口。

映射到的 provider 若不在目录内（目录侧下线或用户手填了不存在的 id），SHALL 报 `unwired` 并指明该 provider 未知，同时给出改选入口。

#### Scenario: 有映射按映射解析

- **WHEN** 某角色绑定映射为 `wangdian`，用户持有 `wangdian` 连接且目录覆盖所声明操作类
- **THEN** 该绑定报 `satisfied`，台账记录该连接的 id

#### Scenario: 无映射不查目录

- **WHEN** 某角色绑定无映射
- **THEN** 该绑定报 `unmapped`，不因「未知 provider」报 `unwired`

#### Scenario: 映射的 provider 覆盖不足

- **WHEN** 某角色绑定要求读写、映射到的 provider 目录只有只读动作
- **THEN** 该绑定报 `unwired` 并指明缺失的写入类，不自动改用替代 provider，状态面给出改选入口

#### Scenario: 映射但无连接

- **WHEN** 某角色绑定已映射为 `wangdian`，但用户没有 `wangdian` 连接
- **THEN** 该绑定报 `missing`（不是 `unmapped`），修复入口是去建立该连接

#### Scenario: 映射到已下线的 provider

- **WHEN** 某角色映射指向目录中不存在的 service id
- **THEN** 该绑定报 `unwired` 并指明未知 provider，状态面给出改选入口

### Requirement: 卸载包后其绑定行转为历史

卸载一个包 SHALL 把该包在 `connector_binding_ledger` 里的一切行置为 `deprecated`，对每个曾
持有该包绑定行的身份都生效；这些行此后 SHALL NOT 计入 `GET /api/connections` 的 `bindings`、
`bindingSummary.packs` 或 `unresolved`，也 SHALL NOT 产生注入行或可点动作。

卸载 SHALL NOT 删除或吊销该包绑定的已授予令牌：卸载是「这个包不再装了」，不是「撤销用户授权」；
重装同一个包时既有授权 SHALL 仍然可用。

卸载 SHALL NOT 影响其他包的台账行。

#### Scenario: 卸载后卡片不再报待办

- **WHEN** 一个包声明了 `connector_bindings` 且已安装，某身份已有其台账行（任意状态）
- **AND** 该包被卸载
- **THEN** 该身份的这些台账行状态为 `deprecated`
- **AND** `/api/connections` 的 `bindings` 中不再出现该包的行，`unresolved` 不因它计数

#### Scenario: 卸载不吊销凭证，也不误伤别的包

- **WHEN** 卸载该包时它已有一条 `kind='binding'` 的槽令牌，且同一身份还有另一个包的绑定行
- **THEN** 槽令牌仍可读到（内容不变），另一个包的行状态不变

#### Scenario: 二次卸载被拒且不改状态

- **WHEN** 对一个已卸载的包再次调用卸载
- **THEN** 调用被拒绝（`Pack not installed`），已有 `deprecated` 行保持 `deprecated`

### Requirement: 无人值守部署的绑定由部署者预铸

一个包被部署为常驻服务（served agent / 定时岗位）时，其声明的绑定 SHALL 在**部署时**由
部署者本人的身份铸出，并存储为部署密钥供该部署使用；运行期 SHALL NOT 依赖服务身份铸造
绑定，因为服务身份不拥有被铸造的凭证。

只有同时满足以下两条的绑定键 SHALL 被铸造：该包 `connector_bindings` 声明中 `optional`
不为真；解析态为 `satisfied`。`unwired`、`undetermined`、`missing` 的键 SHALL NOT 被铸造
（与状态面同语义：目录不覆盖、无法询问、尚未连接都不是可铸状态）。

铸造出的令牌 SHALL 记录其归属部署者与所属部署；该部署者撤销账号或撤销该绑定时，对应
部署密钥 SHALL 一并失效或被删除，重新部署 SHALL 以重新部署者的身份重铸，旧密钥 SHALL NOT
与新密钥并存。

#### Scenario: 无人值守岗位拿到绑定

- **WHEN** 部署者部署一个声明了绑定（`optional` 非真、解析态 `satisfied`）的包为常驻岗位
- **THEN** 部署完成时已存在对应的部署密钥，其值是一枚由部署者账号衰减而来的绑定令牌
- **AND** 运行中的岗位无需任何用户交互即可使用该绑定

#### Scenario: 不可铸状态不静默变通

- **WHEN** 某绑定的解析态为 `missing`、`unwired` 或 `undetermined`
- **THEN** 部署 SHALL NOT 为其铸造令牌
- **AND** 该键在状态面上呈现其原本状态，而不是显示为已授权

#### Scenario: 部署者撤销即失效

- **WHEN** 部署者撤销其账号或删除该绑定
- **THEN** 该部署对应的部署密钥失效/被删除，岗位下一次调用被拒
- **AND** 重新部署需要由重新部署者重铸，不与旧密钥并存

#### Scenario: 重新部署不再需要的绑定不留下活令牌

- **WHEN** 重新部署时某绑定已不再声明、解析态不再是 `satisfied`，或其 agent 已不在服务集合
- **THEN** 对应的部署密钥 SHALL 被删除，连接器侧那枚令牌 SHALL 被吊销
- **AND** 仍在声明范围内的绑定 SHALL NOT 被吊销——本次铸造失败不等于该绑定被放弃

#### Scenario: 卸载只在本单元已无部署时收口

- **WHEN** 卸载一个包，且本单元已不再持有该包的任何部署
- **THEN** 该包的部署密钥 SHALL 被删除，其铸出的连接器令牌 SHALL 全部吊销
- **AND** 若本单元仍有该包的部署，令牌 SHALL 保留：卸载不等于下线，撤销在跑的凭证是静默停服

### Requirement: 部署结果如实呈现绑定的结局

部署提交完成后，部署面 SHALL 呈现本次部署携带的连接器绑定的三类结局：已就绪的绑定、未就绪的
绑定（连同其拒绝原因），以及本次因不再被声明而撤销的令牌数量。呈现 SHALL 只使用绑定键与原因码，
SHALL NOT 呈现任何令牌值。

未就绪的绑定 SHALL NOT 被呈现为已授权，也 SHALL NOT 使部署面表现为整体失败：部署本身已成立，
缺的是该绑定的一次授权条件。自托管等没有连接器的部署 SHALL 不呈现空壳区块。

#### Scenario: 绑定全部就绪

- **WHEN** 部署返回若干已就绪的绑定
- **THEN** 部署面列出就绪数量与绑定键
- **AND** 不出现未就绪或撤销行

#### Scenario: 绑定未能就绪

- **WHEN** 部署返回未就绪的绑定及其原因码
- **THEN** 部署面列出未就绪的绑定键，并给出该原因码对应的修法说明
- **AND** 部署面仍承认部署已成立，不把整次部署报告为失败

#### Scenario: 本次撤销了令牌

- **WHEN** 部署因包不再声明某绑定而撤销了令牌
- **THEN** 部署面报告被撤销的令牌数量

### Requirement: 部署期铸造在持有部署者凭据的进程内完成

部署期绑定铸造 SHALL 使用部署者本人的连接器账号作为父凭证，因此 SHALL 在能够读到该账号的进程内完成。
当处理部署请求的进程不持有该凭据时，平台 SHALL 经由受信任的内部通道，由持有凭据的一侧代为铸造并把
结果交存储方；SHALL NOT 以「与用户未连接账号」相同的信号静默丢失绑定。

无法铸造时，部署 SHALL 仍然成立，且部署面 SHALL 报告该绑定未就绪及其真实原因（进程无凭据，或用户未连接）。

#### Scenario: 拆分拓扑下绑定照常铸出

- **WHEN** 部署请求在市场面进程（不持有用户 cell 数据）处理，且该包声明了一个可铸的绑定
- **THEN** 平台经内部通道用部署者账号铸出该绑定令牌
- **AND** 令牌的值落在部署密钥存储中，运行中的岗位可经既有内部路由取到

#### Scenario: 凭据确实不可达时如实报告

- **WHEN** 部署者从未连接连接器账号，或内部代铸通道不可用
- **THEN** 部署照常完成
- **AND** 部署面报告该绑定未就绪，并区分「进程无凭据」与「用户未连接」两种原因

### Requirement: 注入的 MCP 行名必须通过运行时校验

注入到运行时的连接器 MCP 行，其 `serverName` SHALL 满足 dsh mcp-client 插件的
`^[A-Za-z0-9_-]{1,32}$` 约束。名字 SHALL 由「前缀 + slot 的 slug + 短哈希」构成，
使不同 slot SHALL NOT 撞名，同一 slot SHALL 得到稳定名字。

从名字回解 slot SHALL NOT 依赖字符串解析，SHALL 用产生该名字的同一份定义反查；解析不到时
SHALL 视为非绑定行，SHALL NOT 猜测。

#### Scenario: 名字合规且可反查

- **WHEN** 为任一绑定 slot 生成注入行
- **THEN** 其 `serverName` 匹配 `^[A-Za-z0-9_-]{1,32}$`
- **AND** 用同一份定义可把该名字反查回原 slot

#### Scenario: 不合规的外来名字被收紧

- **WHEN** 运行时收到一个含冒号、空格或超长的 `serverName`
- **THEN** 它在写入运行时配置前被收紧为合规名字
- **AND** 两个不同的原始名字不会收紧成同一个名字
