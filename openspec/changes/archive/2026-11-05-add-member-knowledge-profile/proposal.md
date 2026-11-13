# Proposal: add-member-knowledge-profile

## Why

壹座舰队成员的记忆全落 owner 名下的 `f/<fleetId>` 单项目，成员隔离是事后过滤（标题前缀 + 相关性查询）——agent 没有真正「自己的记忆」；文档集绑定只发生在 blueprint 铸造时（`dataSources[].ref = library:<id>`），运行时不可配置；注入侧记忆与文档是两条互不相交的路。本单把「每 agent 独立记忆 + 独立文档」做成 pack→部署的一等设置（knowledge profile），并将成员记忆切到部署命名空间（硬前置：add-agent-memory-foundation 已提供 metadata、结构化筛选、oversight 与 platform 代铸 deployment 令牌）。

## What Changes

- **成员记忆切部署命名空间**：member 物化时经 platform seam 铸 deployment 令牌（`d/<packId>/<memberId>`，root_owner 绑定 owner）；舰队 capture 分流——岗位私有事实（回合摘要、自身状态迁移）落成员 own 分区，团队事实（拍板、换防）落 `shared`；`f/<fleetId>` 单项目停止新写（存量保留可读，读面双轨过渡）。
- **knowledge profile 一等设置**：pack/蓝图 schema 增 `knowledge` 段（memory 开关、scope、注入预算、文档集引用列表），蓝图作者定默认、部署级可覆盖；物化时编译为「令牌 + 按 member 参数化的 MCP 挂载 + 文档工具边界」。
- **文档集运行时绑定**：部署级设置可增删成员的 library 集合（蓝图 `library:` 引用降级为默认值）；边界仍在服务端工具层强制（KB-scoped member，越界报「不存在」）。
- **注入合一**：execution 侧唯一汇合点（cell mcp 配置生成 + 供给门）按 member 参数化挂载组合；fleetContext 记忆段改为 own ∪ shared（用地基单的结构化筛选），与文档命中共用一个预算梯子——agent 看到一条流。
- **经验沉淀环**：纪律文本（单一来源）告知成员可把读到的文档要点写进自己记忆（memory_write_page 落 own 分区）——文档是原料、记忆是消化过的经验。
- **不加新服务、不改永忆协议**（除消费地基单新增面）；capture 保持零 LLM、fire-and-forget、fail-open。

## Capabilities

### New Capabilities

- `member-knowledge-profile`：成员级 knowledge profile——设置面（蓝图默认 + 部署覆盖）、物化编译（deployment 令牌 + 参数化挂载 + 文档边界）、注入合一与经验沉淀纪律。

### Modified Capabilities

- `fleet-turn-memory`：capture 拓扑从 `u/<owner>/f/<fleetId>` 单项目改为部署命名空间 own/shared 分流；fleetContext 记忆段改读 own ∪ shared。
- `agent-fleet-core`：「岗位记忆独立于对话史存在」的记忆承载位从 owner `f/` 团队 project 改为部署命名空间分区（清史不清记忆语义不变）。

## Impact

- **paas**：`server.js`/`server/fleet-memory.js`（capture 分流 + 令牌形态）、`cell-memory.js`（deployment 令牌铸造与缓存）、`server/fleet-context.js`/`server/fleet-chat-context.js`（own ∪ shared digest）、`server/blueprint-validate.js` + 蓝图 schema（knowledge 段）、cell mcp 配置生成与供给门（按 member 参数化）、管理面（profile 设置读写）。
- **fd-memory**：零协议改动（仅消费 add-agent-memory-foundation 的新面）；平台铸造面按既有变更代铸 deployment。
- **兼容**：存量 `f/<fleetId>` 记忆保留可读；knowledge 段缺省时行为 = 现行（全员挂载、f/ 写入）→ 本单后缺省 = profile 默认值（memory on、scope own+shared、无文档集）；蓝图画布/试跑/diff 链需识别新段。
- **测试**：capture 分流幂等、profile 缺省等价、越界文档拒绝、注入预算截断、seam 单点性（多路径回归断言）。
