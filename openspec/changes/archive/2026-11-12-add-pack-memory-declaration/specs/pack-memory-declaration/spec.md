## Purpose

让团队制品自足地声明自己的记忆：存在哪个粒度、召回什么、谁的结论算数、怎么处理。四轴词汇与解析语义来自仓库根的 `add-agent-memory-declaration`，本能力只负责 pack 作者面与部署面的落地，不定义第二套语义。

## ADDED Requirements

### Requirement: pack 可声明四轴记忆块

pack manifest SHALL 接受可选的顶层 `memory` 段，由四个独立轴构成：`store` / `read` / `write` / `process`。每个轴 MUST 可单独省略；省略的轴 SHALL 由下一层（部署默认）补齐，而非由 pack 填入默认值。

未知轴、未知子键 SHALL 被拒收并指名；键集闭合的理由与既有 profile 一致：一个拼错的键静默不生效，比一次响亮的拒绝更贵。

#### Scenario: 四轴分别声明

- **WHEN** 一个 pack 同时声明 `memory.store.home`、`memory.read.scope`、`memory.write.authority`、`memory.process.distill`
- **THEN** 四者被分别记录，任何一条的存在不改变其它三条的解释

#### Scenario: 拼错的子键被点名

- **WHEN** pack 写 `memory.process.distil: off`
- **THEN** 发布与安装都被拒收，错误指名 `process.distil` 与已知键集

### Requirement: 存储归属只可枚举，不可寻址

`store.home` SHALL 只接受 `fleet`、`member`、`person`。任何寻址形态——root key、`d/<pack>/<member>` 这类半寻址写法、文件路径、DSN、URL——MUST 被拒收，并以独立的错误码区分「写了个地址」与「写了个不认识的枚举值」。

从 `home` 到实际 namespace 的解析 SHALL 只由成员物化时的身份完成；pack MUST NOT 参与路径计算。理由是既有边界：pack 是跨客户分发的制品，一旦能指定地址就能写进不属于它的库。

#### Scenario: 半寻址写法被拒

- **WHEN** pack 声明 `memory.store.home: "d/mypack/agentA"`
- **THEN** 声明被拒收，错误说明只接受三个枚举且地址由身份解析

#### Scenario: member 与 fleet 落在既有隔离模型上

- **WHEN** 同一 pack 的两个团队分别声明 `home: member` 与 `home: fleet`
- **THEN** 前者的记忆落在各团队存储内的成员分区，后者整个团队共享一份；两者都不新开存储实例

### Requirement: agent 级声明覆盖 pack 级

pack 内的每个 agent 条目 SHALL 可声明自己的 `memory` 块，按 agent → pack → 部署默认的顺序继承。agent 未声明的轴 MUST 继承 pack 的同名轴，MUST NOT 回落到平台默认而跳过 pack。

保留的 `memory_scope`（私有/共享）SHALL 视为 `write.authority` 的简写；同一 agent 同时以两种写法给出不同值时 SHALL 被拒收并指名冲突。

#### Scenario: agent 覆盖 pack 的一个轴

- **WHEN** pack 声明 `process.distill: on`，其中某 agent 声明 `process.distill: off`
- **THEN** 该 agent 生效值为 off 且来源标为该 agent，其余 agent 仍为 on

#### Scenario: 两种写法冲突即拒收

- **WHEN** 一个 agent 同时写 `memory_scope: private` 与 `memory.write.authority: shared`
- **THEN** 清单被拒收，错误同时指名两个值

### Requirement: knowledge.memory 是 read 轴的等价写法

既有 `knowledge.memory {enabled, scope, budget}` SHALL 继续有效，并被解释为四轴中的 `read` 轴：`enabled=false` 等价于 `scope: off`，`scope` 取值域不变，`budget` 边界不变。

同一份声明同时给出 `knowledge.memory` 与 `memory.read` 且二者不一致时 SHALL 被拒收。二者等价时 MUST 被接受并归一为同一份规范声明。

#### Scenario: 旧写法继续生效

- **WHEN** 一个只写 `knowledge.memory.scope = own+shared` 的存量蓝图重新物化
- **THEN** 成员读到 own ∪ shared，行为与本次变更前逐字节一致

#### Scenario: 两种写法不一致被拒

- **WHEN** 蓝图写 `knowledge.memory.scope: shared` 同时写 `memory.read.scope: own`
- **THEN** 校验拒收并指名两处冲突的键

### Requirement: guidance 与 authority 并列而不互相冒充

`agent.memory.guidance`（散文，≤600 字）SHALL 保留为「写什么」的纪律文本；`write.authority` 表达「你的结论对别人算不算数」。两者 MUST NOT 互相替代，任一缺失都 SHALL 合法。

`write.authority` MUST NOT 被写入任何存储位置语义的宿主字段（例如 agent 定义 frontmatter 的 `memory` 键），只能以正文纪律与清单校验承载。

#### Scenario: 只有 guidance 也合法

- **WHEN** 一个 agent 只写 `memory.guidance` 而不写 `write.authority`
- **THEN** 清单通过校验，权威轴按继承链解析

#### Scenario: 权威不进位置槽

- **WHEN** 团队物化生成的 agent 定义被检查
- **THEN** 其中没有任何取值为 `private`/`shared` 的存储位置字段

### Requirement: 处理策略落地为记忆根的策略

团队实例由 pack 落地时，pack/agent 声明的 `process` 轴 SHALL 编译为该 pack **记忆根**的策略（部署默认之上的一层），并通过既有幂等写入路径落地；声明撤销或团队归档 SHALL 清理对应行。

落地的粒度 SHALL 与存储粒度一致，MUST NOT 假装比存储更细：成员的记忆命名空间是 `d/<pack>/<agent>`（根 = `d-<pack>`），因此策略的自然作用域是 pack 记忆根，而不是某一个 fleet 行。当同一个 pack 被不同所有者各落地一个团队时，这些团队共享同一个记忆根，策略也共享——这是记忆中台既有的属性。读面 SHALL 显示策略所在的根键，使调用方看得出作用域；MUST NOT 把它呈现为「仅影响本合同」。

`process` 中尚无执行方的子键 SHALL 被如实标为未执行，MUST NOT 呈现为已生效。

#### Scenario: 落地即生效

- **WHEN** pack 声明 `process.distill: off` 并落地为一个团队实例
- **THEN** 该 pack 记忆根的策略读到 off，该团队成员的蒸馏不再发生

#### Scenario: 作用域与存储粒度一致

- **WHEN** 两个不同所有者各自用同一个 pack 落地一个团队
- **THEN** 两者共享同一个记忆根与同一份策略，读面显示的根键相同——不会出现「同一根下两份相反的策略」

#### Scenario: 撤销后不留残行

- **WHEN** 团队的来源 pack 被卸载，或团队归档
- **THEN** 该 pack 记忆根的策略行被清理，蒸馏等行为回到部署默认

#### Scenario: 未执行子键不冒充生效

- **WHEN** pack 声明 `process.cold_after_days: 90`
- **THEN** 读面返回该有效值的同时标出它未被执行，调用方不会把它当作冷存已生效

### Requirement: 四列读面

pack 预览与团队管理面 SHALL 对每一轴给出：声明值、继承来源、生效值、是否已执行。某轴无法解析为有效值时 MUST 报错并指名该轴，MUST NOT 静默回落到默认值。

`knowledge` 段的合并是**整段替换**（覆盖层提到该段即整体顶掉上一层的段），与根仓的逐键继承不同。当某层的声明因此没有进入生效值时，读面 MUST 标出它被哪一层顶掉，MUST NOT 呈现为它仍在生效。

#### Scenario: 三列并排可见

- **WHEN** 部署者查看某团队的记忆声明
- **THEN** 同一行同时可见声明值、继承来源与生效值，并区分「未声明」与「声明为默认值」

#### Scenario: 坏声明不被默认值掩盖

- **WHEN** 某 pack 声明了当前版本不认识的 `process` 子键
- **THEN** 预览对该 pack 报错并指名该子键，而不是呈现一份看起来正常的默认声明

#### Scenario: 被顶掉的声明可见

- **WHEN** 蓝图声明 `knowledge.memory.scope: shared`，部署覆盖提到该段但未给 `scope`
- **THEN** 读面把 `shared` 标为被部署层顶掉（`shadowed_by`），生效值取平台默认，调用方不会误以为蓝图的值仍在生效
