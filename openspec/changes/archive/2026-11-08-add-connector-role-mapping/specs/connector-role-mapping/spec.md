## Purpose

让包声明「我需要一个 WMS」而由客户声明「我的 WMS 是哪个」：把绑定的 provider 从固定厂商解耦成角色 + 每用户映射，使目录里没有的品牌、客户自建系统也能被如实解析与授权，而不是永久报「产品不支持」。

## ADDED Requirements

### Requirement: 角色形态的绑定声明

绑定 SHALL 能以角色形态声明：条目带 `providerRole: true` 时，`provider` 的取值 SHALL 被解释为**角色名**（业务语义词，如 `wms`），而非连接器目录 service id。未带该标记时 `provider` 的语义不变。

角色名 SHALL 作为该绑定的映射键：同一角色在所有包、所有绑定上共享同一份用户映射；同一包内不同绑定使用同一角色 SHALL 视为同一需求。

角色形态不影响其余声明字段的语义与校验：授权范围（`allowOperations`/`allowActions`）、`optional`、`key` 唯一性、人读字段不参与判定，均与非角色形态一致。

#### Scenario: 角色声明被接受为可映射条目

- **WHEN** 包的某条绑定为 `provider: "wms"` 且带 `providerRole: true` 与 `allowOperations`
- **THEN** 包通过声明校验，该绑定成为可解析条目，且绑定的映射键为 `wms`

#### Scenario: 不带标记时语义不变

- **WHEN** 某条绑定为 `provider: "kingdee"` 且不带 `providerRole`
- **THEN** 平台按目录 service id 解析，不查询任何映射，行为与本次变更前一致

#### Scenario: 同一角色跨包共享映射

- **WHEN** 两个包各自声明一个角色为 `wms` 的绑定，用户已为 `wms` 选定 `wangdian`
- **THEN** 两个包的该绑定都以 `wangdian` 解析，不要求用户选两次

### Requirement: 每用户角色映射

平台 SHALL 按 `(用户, 角色)` 维护至多一条映射，记录所选连接器 service id 与写入时间。写入 SHALL 幂等：同一角色重复选择同一 provider 不产生新行、不改动已授权令牌。

映射 SHALL 可改选：改选后该角色的解析结果以下一次解析为准。映射 SHALL 可清除：清除后该角色回到未映射。

映射 SHALL 只对当前用户生效，MUST NOT 跨用户共享，也 MUST NOT 由平台预设默认值——替客户猜一个厂商，等于把「你有没有接通」这个事实变成平台的猜测。

#### Scenario: 选定映射

- **WHEN** 角色 `wms` 未映射，用户为它选定 `wangdian`
- **THEN** 该用户下角色 `wms` 的映射为 `wangdian`，此后声明该角色的绑定按 `wangdian` 解析

#### Scenario: 重复选择不产生副作用

- **WHEN** 用户连续两次为同一角色选定同一 provider
- **THEN** 映射行数不变，已授权令牌不被重铸

#### Scenario: 改选与清除

- **WHEN** 用户把角色 `wms` 从 `wangdian` 改选为 `kuaidi100`，随后清除该映射
- **THEN** 改选后解析按 `kuaidi100` 进行；清除后该角色回到未映射，且平台不自动回退到任何 provider

#### Scenario: 不跨用户、不预置

- **WHEN** 用户 A 已为 `wms` 选定 provider，用户 B 首次解析某角色 `wms` 的绑定
- **THEN** 用户 B 的该绑定报未映射，不继承 A 的选择

### Requirement: 候选来自用户已连通的连接

角色映射的可选候选项 SHALL 取自该用户连接器里**已配置**的连接，并 SHALL 只包含目录动作面能覆盖该绑定所声明操作类的 provider。

平台 MUST NOT 提供全目录浏览式选择：没有账号的系统选了也接不通，把 1570 个 provider 全量摊给用户是把配置问题伪装成选型问题。未出现在候选里的系统，界面 SHALL 给出「先去连接器连上」的下一步，而不是让它以不可用选项出现。

#### Scenario: 候选只含已连通且覆盖所需操作类

- **WHEN** 用户已连通 `wangdian`（仅只读动作）与 `kingdee`（读写），某角色绑定要求读
- **THEN** 候选含 `kingdee` 与 `wangdian`；若该绑定要求写，则候选只含 `kingdee`

#### Scenario: 未连通不列为候选

- **WHEN** 用户在目录里没有 `sf_express` 的连接
- **THEN** `sf_express` 不出现在该角色的候选中，界面提示先建立连接

#### Scenario: 目录不足不列为候选

- **WHEN** 某 provider 已连通但目录动作面不覆盖绑定要求的操作类
- **THEN** 该 provider 不出现在候选中，且原因可读（缺口为哪个操作类）

### Requirement: 映射变化触发重算与重新授权

角色映射的选定、改选或清除 SHALL 触发重算该用户下所有声明该角色的绑定（跨包），而不是只重算当前包。

当重算使某绑定的目标 provider 与其令牌所记载的授权对象不一致时，平台 SHALL 吊销该绑定令牌并把状态置为需要重新授权——映射改了而令牌留着，等于让会话继续用一个用户没为这个系统授予的范围。

#### Scenario: 改选后跨包重算

- **WHEN** 用户把角色 `wms` 改选为另一 provider，两个已装包都声明该角色
- **THEN** 两个包的该绑定都被重算，任一不再匹配的令牌被吊销，状态面显示需重新授权

#### Scenario: 清除映射不等于吊销全部

- **WHEN** 用户清除某角色映射
- **THEN** 该角色的绑定回到未映射且不再注入；其他角色的绑定与其令牌不受影响

### Requirement: 未映射不冒充其他状态

未映射的角色绑定 SHALL 以独立状态呈现，MUST NOT 报为 `unwired`（目录能力缺口）或 `missing`（用户已选定但未连接）——三者的修复动作不同：换一个能覆盖的系统、去连上已选的系统、先选定系统。

未映射 SHALL 计入「待处理」：非 optional 的角色绑定未映射时，包 MUST NOT 呈现为「已接通」。optional 的角色绑定未映射 SHALL 只降级该绑定。

未映射 MUST NOT 阻止包安装本身。

#### Scenario: 未映射独立可辨

- **WHEN** 某非 optional 角色绑定尚未选定系统
- **THEN** 该绑定报未映射，包呈现为待连接，界面给出「选择你的系统」入口，而不是「去连接」或「能力不支持」

#### Scenario: optional 未映射只降级

- **WHEN** 某 optional 角色绑定未映射而其余绑定已满足
- **THEN** 包照常安装并可用其余绑定，状态面标注该绑定未映射
