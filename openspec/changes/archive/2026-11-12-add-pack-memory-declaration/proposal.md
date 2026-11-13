## Why

Pack 制品已经把技能、MCP 引用、人设、插件声明齐了，唯独**记忆**没有位置：团队制品能被分发、克隆、导出，但它「怎么记事、记多久、谁能看见」只能靠部署运维口头约定。

而 cell 侧已有的 `knowledge.memory`（`own+shared|shared|off` + 预算）只覆盖了四条轴里的一条（读面），且它的名字与 roster 的 `memory_scope`、宿主 frontmatter 的 `memory` 指向三个不同的东西——同一个词，三套语义，其中一套还会让 agent 定义装不上。词汇与解析已由仓库根的 `add-agent-memory-declaration` 定稿（四轴：`store` / `read` / `write` / `process`），本变更把 paas 的作者面接到那份词汇上，不另立一套。

## What Changes

- pack manifest 增**第七个声明面** `memory`（可选）：四轴块，`store.home` 只接受枚举、`read.scope/budget` 沿用现行取值与边界、`write.authority` 表达角色权威、`process` 表达蒸馏/晋升/冷存。agent 条目同样可声明 `memory`，按 agent → pack → 部署默认继承。
- `knowledge` 段收进该词汇：`knowledge.memory` 作为 `read` 轴的别名保留（存量 pack 与蓝图零改动），新写法 `knowledge.read` 与之等价；两者同时出现且不一致 SHALL 被拒收。
- `agent.memory.guidance`（≤600 字散文）保留为**纪律文本**，与 `write.authority` 并列而不互相冒充：guidance 是「写什么」，authority 是「你的结论算不算数」。
- 团队实例落地时，pack 的 `process` 声明 SHALL 编译为该团队的 fd-memory policy（部署默认之上的一层），cell 不再是处理策略的唯一发言人。
- 读面 SHALL 暴露「声明 / 继承来源 / 生效 / 是否已执行」四列，未执行的子键（`promote_after`、`cold_after_days`）MUST 标为未执行，不得呈现为已生效。
- **BREAKING**：无。未声明 `memory` 的 pack 与今天逐字节一致；`knowledge.memory` 旧写法继续有效。

## Capabilities

### New Capabilities

- `pack-memory-declaration`: pack 与 pack 内 agent 的四轴记忆声明契约——枚举边界（不可寻址）、与 `knowledge.memory` 的等价与冲突拒绝、继承链、团队落地为 fd-memory policy、四列读面与 `executed` 标志、未声明即零改动。

### Modified Capabilities

- `member-knowledge-profile`: 「knowledge profile 是 pack 到部署的一等设置」这条需求改口径——`memory` 段是四轴词汇里 `read` 轴的表达，不再是记忆声明本身；profile 的读写面 SHALL 同时给出继承来源与生效值，使「声明了但没生效」在管理面可见。

## Impact

- **lib/pack-manifest.js**：新增 `memory` 段与 agent 级 `memory` 的形状校验（闭合键集、枚举、预算边界、`store` 禁寻址），与 `knowledge.memory` 的等价/冲突判定。校验纯函数化，发布面与安装面共用同一份。
- **server/knowledge-profile.js**：`memory { enabled, scope, budget }` 作为 `read` 轴的规范化入口保留；新增继承解析与四列输出。
- **server/routes/fleets.js**：knowledge-profile 读写面增四列；团队物化路径把 `process` 写入该团队的 fd-memory policy（幂等，归档时清理）。
- **不引入**：新的存储后端、per-agent 独立数据库、跨根共享。`store.home=member` 仍落 `d-<pack>/<member>` 分区。
- **依赖**：词汇与解析语义以根仓 `add-agent-memory-declaration` 为准（fd-agent-graph 与 fd-memory 各有一份实现，由共享 fixture 对账）。本变更 MUST NOT 另写第三份实现——解析复用该 fixture 的语义，任何分歧先改根仓再改这里。
- **兼容性**：不声明 `memory` 的 pack、以及只写 `knowledge.memory` 的蓝图，行为与今天一致。
