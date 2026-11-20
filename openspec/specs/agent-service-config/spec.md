# agent-service-config Specification

## Purpose
为 Agent 服务的部署实例立「服务配置」层：部署者可重写的运行参数集（工作节奏、回合预算、AgentCard 展示字段、模型），挂部署不挂版本——定义其读写面、写时车道校验、两档生效语义与升级存续。

> 实现归属：萬星 console 前端（console agent 详情页）在 console 实现仓——本仓承载 API 双门（gateway/packs.js）与 runner 热切——跨仓行为契约，审计时按文件间一致性核对。

## Requirements

### Requirement: 服务配置读写面

平台 SHALL 在萬星 console 的 agent 详情页暴露服务配置的读写面，谦面 pack 详情的部署区以跳转指向它；可写维度为工作节奏、回合预算、AgentCard 展示字段与模型。写入权限限定于该部署的部署者与平台管理员（与部署动作同门禁）；pack 作者不能修改非本人部署的服务。读取 SHALL 呈现每个维度的生效值及其来源（部署者已覆盖 / 跟随声明默认）。一切写入 SHALL 落在部署的 registry descriptor（经 facet 部署面 API）；门面（wanxing facade）不承载服务配置。

#### Scenario: 部署者在 console 改写节奏

- **WHEN** 部署者在 agent 详情页提交新的工作节奏
- **THEN** 生效节奏更新，来源标记为「已覆盖」，registry descriptor 同步新值

#### Scenario: 非部署者作者被拒

- **WHEN** pack 作者（非该部署的部署者、非管理员）尝试写入服务配置
- **THEN** 写入被拒绝并指明权限原因，配置不变

#### Scenario: 生效值与来源可见

- **WHEN** 读取服务配置
- **THEN** 每个维度呈现当前生效值，且标明它是部署者覆盖还是跟随声明默认

### Requirement: 写时车道校验

模型写入 SHALL 仅在所选模型同时满足两个约束时被接受：其一，该模型在部署键于 sub2api 绑定的授权车道内；其二，当服务契约声明了模型白名单时，也在白名单内。拒绝 SHALL 指明违反的约束且不落任何变更——不存在"带未授权车道上线后运行时 404"的路径。

#### Scenario: 未授权车道被拒

- **WHEN** 部署者提交一个部署键 group 未授权的模型
- **THEN** 写入被拒绝，错误指明车道授权约束，配置不变

#### Scenario: 作者白名单收窄

- **WHEN** 服务契约声明模型白名单，部署者提交白名单外的模型（即便车道已授权）
- **THEN** 写入被拒绝，错误指明白名单约束

#### Scenario: 合法模型被接受

- **WHEN** 部署者提交一个车道已授权且在白名单内（或无白名单）的模型
- **THEN** 模型记入服务配置，descriptor 记录其为生效模型

### Requirement: 生效值优先级

每个维度的生效值 SHALL 按「部署者覆盖 → 服务契约/manifest 声明 → runner 部署默认」解析；模型维度为「descriptor 生效模型 → runner 默认模型」。descriptor SHALL 记录解析后的生效值。

#### Scenario: 覆盖胜出

- **WHEN** 部署者覆盖了某维度且 manifest 亦声明了该维度
- **THEN** 生效值取部署者覆盖

#### Scenario: 无覆盖回落声明

- **WHEN** 部署者未覆盖某维度而 manifest 声明了默认
- **THEN** 生效值取声明默认，来源标记为跟随声明

#### Scenario: 模型缺省回落 runner 默认

- **WHEN** 服务配置未设模型且 manifest/契约亦未声明
- **THEN** child 运行于 runner 部署级默认模型，descriptor 不记模型字段

### Requirement: 两档生效语义

服务配置变更 SHALL 分三类通道生效：① descriptor 字段（节奏、预算、卡片展示）经 runner 既有 descriptor 轮询无感生效（五分钟窗内）；② **模型变更经会话边界热切**——runner 停车图（pod 成员图或 solo 单成员同构）被运行时更新，**新会话取新模型、在途会话保持旧模型直至其结束**，窗内新旧并存是设计语义而非不一致，SHALL NOT 由此排干 child 或重启进程，SHALL NOT 为此引入进程级重启通道；③ 其余组合级字段（persona、skills、MCP 服务器与工具白名单、名称、预算物化、密钥引用、计费键引用、通知绑定、数据工作区、pack 版本）经升级同款的排水重生——排干在途回合、child 以新组合重生（同窗生效）。模型合法性（部署键 group 车道授权）仍在**配置写入时校验**，本变更不触碰校验语义。

#### Scenario: 节奏变更无感生效

- **WHEN** 部署者改写工作节奏且无模型变更
- **THEN** 无进程中断，新节奏在五分钟窗内被 runner 采纳

#### Scenario: 模型变更排水重生

- **WHEN** 部署者改写模型
- **THEN** 在途回合被排干（排水中新回合得到明确排水错误而非挂起），child 以新模型重生，五分钟窗内生效——**本变更废止此通道对模型字段的适用**：模型变更此后由「模型变更会话边界热切」承接，本场景仅在组合级混合变更伴随模型时经重生物化新模型的意义上保留关联

#### Scenario: 模型变更会话边界热切

- **WHEN** 部署者改写模型
- **THEN** 不发生任何进程排干或重启；此后新开的会话以新模型运行，变更时已在途的会话保持旧模型直至结束

#### Scenario: pod 内单成员模型热切不波及兄弟

- **WHEN** pod 共宿的某 pack 成员部署改写模型，其余成员无变更
- **THEN** 仅该成员的停车图被更新，pod 进程与其余成员的会话零中断

#### Scenario: 组合级变更维持排水重生

- **WHEN** 部署者改写 persona（或 skills、MCP 白名单、预算等任一组合级字段）
- **THEN** child 经排水重生通道重建（排干在途回合、下次触达以新组合物化），模型不因此重置

#### Scenario: 模型+组合级混合变更

- **WHEN** 同一次重部署同时改写模型与组合级字段
- **THEN** 组合级走排水重生，重生后的新组合以新模型物化（一次排水完成全部变更，不叠加两次中断）

#### Scenario: 车道授权校验语义不变

- **WHEN** 部署者写入模型配置
- **THEN** 部署键 group 车道授权仍在写时校验，运行时热切只接受已授权车道，未授权写入在配置面被拒

### Requirement: 升级存续（Overlay 语义）

服务配置 SHALL 挂在部署上、不挂在包版本上：升级时已覆盖维度保留部署者之值，未覆盖维度跟随新版本 manifest 默认；升级 SHALL NOT 重置服务配置。

#### Scenario: 已覆盖维度跨升级保留

- **WHEN** 部署者覆盖过节奏后升级 pack 版本
- **THEN** 生效节奏仍为部署者覆盖值

#### Scenario: 未覆盖维度跟随新默认

- **WHEN** 部署者未覆盖回合预算，新版本 manifest 修改了 `budget.turnMinutes`
- **THEN** 生效预算取新版本默认，来源标记为跟随声明

#### Scenario: 模型跨升级持久

- **WHEN** 部署者设定过模型后升级 pack 版本
- **THEN** 生效模型不变
