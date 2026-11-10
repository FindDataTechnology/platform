# member-knowledge-profile Specification

## Purpose
让舰队每个成员拥有独立的记忆分区与可运行时配置的文档集：以 pack→部署的一等 knowledge profile（蓝图默认+部署覆盖）编译出 deployment 令牌与参数化挂载，注入侧记忆与文档共用统一预算，成员间隔离由服务端强制而非事后过滤。

## Requirements

### Requirement: 成员物化铸造部署令牌且缓存重启稳定

member 物化 SHALL 经 platform seam 为每个成员铸造 deployment 令牌（`d/<packId>/<memberId>`，fd-memory 铸造面落 root_owner 绑定）；令牌 SHALL 按部署+成员缓存于 cell 数据根（一人一枚、重启稳定、0600 权限），换防保留令牌（token 归岗位不归模型实例）。铸造或令牌面任何失败 SHALL 降级开——成员记忆挂载缺席，回合照常执行；MUST NOT 阻塞物化或污染回合。platform 令牌自身 MUST NOT 进入任何成员的运行时上下文。

#### Scenario: 物化铸令牌且挂载缺席不阻塞

- **WHEN** 一支新团队物化出三个成员岗位，且记忆面不可达
- **THEN** 三个成员照常物化并执行回合（记忆工具与注入段缺席），铸造重试有计数观测

#### Scenario: 换防令牌不换

- **WHEN** 某岗位执行清史重开换防
- **THEN** 该岗位的 deployment 令牌与缓存不变，新在岗者沿用同一记忆分区

### Requirement: knowledge profile 是 pack 到部署的一等设置

pack/蓝图 schema SHALL 增 `knowledge` 段：memory（开关、scope：own+shared|shared|off、注入预算）、文档集引用列表（`library:<collectionId>`）。蓝图作者定义默认值；部署级 SHALL 可覆盖（管理面读写，覆盖留痕）。profile 缺省时 SHALL 使用文档化默认（memory on、scope own+shared、预算取现行 fleetContext 记忆段默认、无文档集）。schema 校验、试跑、diff 三链 SHALL 识别该段；非法引用（悬空集合、越权集合）SHALL 校验期拒绝。

#### Scenario: 蓝图默认加部署覆盖

- **WHEN** 蓝图声明某成员文档集 [lib_a, lib_b]，部署者在部署设置中追加 lib_c
- **THEN** 该成员物化后的文档工具边界为三集合 ∪ shared，覆盖记录可在管理面查看

#### Scenario: 缺省 profile 行为文档化

- **WHEN** 存量蓝图（无 knowledge 段）重新物化
- **THEN** 成员获得默认 profile（memory on、own+shared、无文档集），与文档化默认一致

### Requirement: 挂载组合收在 execution 侧唯一汇合点按 member 参数化

成员记忆 MCP 挂载与文档工具边界的组合 SHALL 只在车道工具供给的唯一收敛处（cell mcp 配置生成 + 供给门）按 member 参数化生成；任何回合构造路径（cron/fleet/room/wake）MUST NOT 各自补挂载（seam 单点纪律）。挂载组合 = deployment 令牌的 fd-memory MCP 行 + knowledge profile 决定的文档工具边界参数。多路径回归 SHALL 断言「任一回合路径产出的 mcp patch 中 memory 挂载与文档边界一致」。

#### Scenario: 多路径挂载一致

- **WHEN** 同一成员分别经 cron 回合、手动唤醒、房间召唤执行
- **THEN** 三者 mcp patch 中的 memory 挂载与文档集合边界完全一致（断言级验证）

#### Scenario: profile 关闭即缺席

- **WHEN** 某成员 knowledge.memory = off
- **THEN** 该成员 mcp patch 无 fd-memory 行、fleetContext 无记忆段（不留占位）

### Requirement: 文档集运行时绑定且边界服务端强制

部署级对成员文档集的增删 SHALL 即时生效（成员下一回合可见），无需重铸部署；边界 SHALL 在服务端工具层强制执行（KB-scoped member：本项目 ∪ 授权集合 ∪ shared），越界 `read_document` SHALL 报「不存在」而非「无权」。文档本体 MUST NOT 进记忆真源——文档是原料，经经验沉淀纪律由成员消化为自己的记忆页。

#### Scenario: 运行时增删集合即时生效

- **WHEN** 部署者从成员 profile 移除 lib_b
- **THEN** 该成员下一回合起 read_document 对 lib_b 内容报「不存在」，其余集合不受影响

### Requirement: fleetContext 记忆段读 own ∪ shared 并与文档共预算

fleetContext 记忆段 SHALL 改读部署命名空间：成员 own 分区 digest（结构化筛选按本成员）+ shared 分区 digest，复用既有 digest 契约（硬预算、层标注、forget/superseded 排除）；记忆段与文档命中段 SHALL 共用一个注入预算梯子（记忆优先、文档随后、逐档截断标注），agent 侧呈现为一条流。不可达或缺席时段缺席（显式降级，不留占位假绿）；段预算计入 fleetContext 既有总量上限。

#### Scenario: own 与 shared 合流

- **WHEN** 成员 own 分区有本岗位经验、shared 有团队拍板，两者均可达
- **THEN** 记忆段同时呈现两类条目且各自带分区/层标注，合计在预算内

#### Scenario: 记忆与文档共梯子

- **WHEN** 记忆 digest 已占预算大头且本回合文档命中较多
- **THEN** 按梯子顺序截断并标注，总量不超上限，不挤掉下级报数段

### Requirement: 经验沉淀纪律入双面单一来源

纪律文本（单一来源、双面共享）SHALL 增经验沉淀段：成员读到文档中与岗位相关的要点时，SHALL 主动以 memory_write_page 写入自己的 own 分区（零 LLM 侧由写触发蒸馏接续）；纪律 SHALL 明确「文档要点≠记忆」——只有被消化、带出处（文档引用）的页面才构成记忆。纪律文本变更 SHALL 与 chat 侧共用同一字符串（防漂移）。

#### Scenario: 成员沉淀文档要点

- **WHEN** 成员从 lib_a 读到与岗位相关的操作要点
- **THEN** 其 own 分区出现带文档出处的记忆页，写触发蒸馏按既有预算接续
