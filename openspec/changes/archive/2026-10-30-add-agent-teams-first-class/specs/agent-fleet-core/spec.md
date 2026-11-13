# agent-fleet-core delta

## MODIFIED Requirements

### Requirement: 舰队管理面提供全生命周期操作

web 应用 SHALL 提供舰队管理面：舰队列表（名称、状态、成员数、整体在岗概况、默认模型、待拍板件数、最近活动时刻）、组织树视图（岗位卡：岗位名/在岗者/节奏或被动标记/派生态）、编队器（选择既有 persona/cluster/a2a 目标、命名岗位、设定节奏（可留空建被动岗）与组织关系）、以及暂停/恢复/归档/解散与成员增删改、换防操作。归档 SHALL 停止全部物化任务但保留全部历史可读；对已归档舰队 SHALL 拒绝节奏类写操作并以显式状态说明。过密节奏（触发间隔低于阈值）在创建时 SHALL 要求显式确认。

舰队列表 SHALL 支持**行内快速编辑**三类字段：名称、默认模型与状态（active↔paused），复用既有单舰队 PATCH 语义并以服务端返回值刷新该行；编导边与 effort/上下文预算 SHALL NOT 出现在行内编辑入口（需要 diff 确认与影响面提示，仅在驾驶舱提供）。舰队列表 SHALL 支持勾选多支舰队，经单一批量端点执行 暂停 / 恢复 / 归档，并在响应中逐条回执每个舰队的成功或结构化失败原因。批量动作 SHALL NOT 因单条失败而中断其余执行，MUST NOT 把部分失败呈现为全部成功。归档为终态，批量归档 SHALL 要求二次确认。

舰队管理面 SHALL 与综合看板（跨舰队聚合读面）共存于同一导航项，并以视图切换区分；舰队管理面 MUST NOT 取代或内嵌驾驶舱——每行 SHALL 提供直达该舰队驾驶舱的入口，既有 `/fleets/:id` 深链语义不变。

#### Scenario: 编队器建队

- **WHEN** 用户在编队器中选择两个 persona 与一个市场 a2a agent，命名三个岗位并设定节奏，提交建队
- **THEN** 舰队与三个岗位落库，各岗位物化任务就绪，管理面立即可见组织树

#### Scenario: 过密节奏需确认

- **WHEN** 用户为某岗位设定每分钟级节奏
- **THEN** 界面呈现成本警示并要求显式确认，未确认不落库

#### Scenario: 归档保史

- **WHEN** 用户归档一支舰队
- **THEN** 其全部物化任务停止，舰队态转为 archived，历史回合记录仍可读，且对归档舰队的节奏修改被拒绝并说明原因

#### Scenario: 行内改默认模型

- **WHEN** 主人在舰队列表某行把默认模型从 A 改为 B
- **THEN** 该行以服务端返回的默认模型呈现，未声明模型的岗位其生效模型随之变化，其他舰队不受影响

#### Scenario: 行内不暴露编导与预算

- **WHEN** 主人查看任一舰队行的可编辑控件
- **THEN** 只有名称、默认模型、状态三类入口，不存在编导边或 effort/上下文预算的编辑入口

#### Scenario: 批量暂停逐条回执

- **WHEN** 主人勾选 4 支舰队执行暂停，其中 1 支已归档
- **THEN** 其余 3 支进入 paused，归档那支以结构化错误回执（终态不可变更），界面呈现成功 3 / 失败 1 并列出失败原因

#### Scenario: 管理行直达驾驶舱

- **WHEN** 主人在舰队管理某行点「进驾驶舱」
- **THEN** 路由进入 `/fleets/<该舰队 id>` 并呈现该舰队驾驶舱，而非在管理面就地展开

### Requirement: 舰队操作经 REST API 暴露且鉴权与既有面一致

舰队与岗位的全生命周期操作 SHALL 以 REST API(/api/fleets 前缀)暴露,鉴权与身份语义 SHALL 与既有集群/定时任务面一致(auth-on 走 forward-auth 用户,auth-off 归机器主人);用户 SHALL 只能读写自己拥有的舰队。非法输入(缺岗位名、非法 cron、未知 targetRef 类别)SHALL 以结构化错误拒绝且不落库。

模型声明的写面:建岗与改岗 SHALL 接受可选 `model` 与 `fallbackModel`(`null` = 清除,回到继承);舰队设置面 SHALL 接受可选 `defaultModel`。校验 SHALL 复用既有三闸——标识符形状、宿主模型 roster、计费车道(已绑计费才校验)——失败 SHALL 以结构化错误如实拒绝并指名违反的是哪一闸。`fallbackModel` 仅在 `model` 非空时可设;清空 `model` 时 `fallbackModel` 仍非空 SHALL 拒绝并提示先清兜底。a2a 岗位与 cluster 岗位设置模型 SHALL 拒绝(a2a 的模型归该服务的部署配置,集群岗归各成员岗位)。所有返回岗位读面的接口 SHALL 带 `model`、`fallbackModel` 原值与 `effectiveModel`——由服务端按解析链与读时 roster 计算,标注 advisory(读时与回合时 roster 可能漂移)。

批量写面 SHALL 以 `POST /api/fleets/batch` 提供,请求体为 `{action, ids}`,`action` SHALL 限于 `pause`/`resume`/`archive`,`ids` SHALL 为舰队 id 数组且长度受运营策略上限约束(默认 50,超限以结构化错误拒绝整批且不执行任何一条)。服务端 SHALL 逐舰队串行执行既有单舰队语义并在 `results[]` 中逐条返回成功或结构化失败原因;单条失败 MUST NOT 中断其余执行;请求体合法时 HTTP 状态 SHALL 为 200。越权 id SHALL 以与「不存在」一致的失败呈现,不泄漏他舰队任何内容。

#### Scenario: 越权拒绝

- **WHEN** 用户 A 请求修改用户 B 的舰队
- **THEN** 请求被拒绝且不产生任何变更

#### Scenario: 非法 cron 拒绝

- **WHEN** 创建岗位时提交非法 cron 表达式
- **THEN** 返回结构化错误,无岗位与物化任务产生

#### Scenario: 建岗带模型回显

- **WHEN** 主人建岗时带 `model: "cheap-model"`,随后 PATCH 改为 `null`
- **THEN** 建岗后岗位读面回显 `model: "cheap-model"`,PATCH 后回显 `null` 且 `fallbackModel` 同样为 null

#### Scenario: 三闸拒绝指名

- **WHEN** 主人建岗时带不在宿主 roster 里的 `model: "ghost-model"`
- **THEN** 返回结构化错误且文案指名「不在宿主模型 roster」,岗位不落库

#### Scenario: 兜底缺首选拒绝

- **WHEN** 主人 PATCH 岗位只设 `fallbackModel` 而 `model` 为空,或置 `model: null` 时 `fallbackModel` 仍非空
- **THEN** 均以结构化错误拒绝并提示兜底依赖首选,岗位模型声明不变

#### Scenario: 非 persona 岗位设模型拒绝

- **WHEN** 主人给 targetRef 为 a2a 或 cluster 的岗位设置 `model`
- **THEN** 以结构化错误拒绝并说明模型归服务部署配置/各成员岗位

#### Scenario: 读面带生效模型

- **WHEN** 岗位未声明模型而舰队设了 `defaultModel`,主人读取舰队详情
- **THEN** 岗位读面 `model` 为 null、`effectiveModel` 为舰队默认(该模型在读时 roster 中命中)

#### Scenario: 批量端点越权 id 逐条拒绝

- **WHEN** 批量请求的 ids 含一个不属于当前主人的舰队 id
- **THEN** 该 id 在 `results[]` 中以失败返回,同批其余属于该主人的舰队照常执行,响应不泄漏该舰队任何内容

#### Scenario: 批量 ids 超上限整批拒绝

- **WHEN** 批量请求的 ids 数超过上限
- **THEN** 端点以结构化错误拒绝整批,不执行其中任何一条
