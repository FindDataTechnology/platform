## MODIFIED Requirements

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

## ADDED Requirements

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
