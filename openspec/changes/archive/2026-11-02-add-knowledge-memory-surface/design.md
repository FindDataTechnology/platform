# Design: add-knowledge-memory-surface

## Context

见 proposal.md - Why。设计输入的现状约束（均已代码核实）：

- library MCP 是独立 server（`server/library-mcp.js`，四工具），经 dsh 配置通道挂载；@doc/@collection 展开已指向 `mcp__library__*`（`server/skills.js`）。
- 团队车道的横切注入有建制教训：注入必须收在 execution 侧唯一汇合点（fleet-context-injection-seam，真机 A/B 铁证），enqueue 侧多写手必漏。
- dsh 工具供给白名单门已有两例（browser-mcp 薄启动器、pack 人格放行 PACK_BASELINE_MCP）。
- 蓝图 v2 `dataSources[].ref` 合法面现只含 registry 服务名/internal store 逻辑名（`server/blueprint-validate.js`、blueprint-author 纪律文本）。
- 记忆读取 API 支持 layer/tier/scope 筛选（memory-portal-ui 在产），晋升 accept/ignore 已在产。
- 导航由 surface registry 单源驱动（`packages/core/src/lib/surfaces.ts` + 预设解析），谓词先于渲染。

## Goals / Non-Goals

**Goals**：让团队与房间车道用得上库且边界可靠；让"用知识库做 agent"成为蓝图里一次引用；让永忆的层级能力在展示上看得懂。

**Non-Goals（设计层面）**：不改 library 检索算法本体；不做集合级 ACL 与共享申请流（shared 语义见 D2，取最省定义）；不动智语房间协议与铸造发行链；不做引用反查观测。

## Decisions

**D1 · 车道挂载收在 execution 侧汇合点，不在各 enqueue 路径重复。**
备选是在每条回合构造路径（cron/fleet/room/wake）分别补挂载。否决：seam change 的定律——路径增长必漏。落点=车道工具供给的唯一收敛处（cell mcp 配置生成 + 供给门），chat 现链不动。

**D2 · 边界在服务端工具层强制执行；shared = 无项目归属（全局）集合。**
备选 A：提示词约束"只查本项目的库"——否决，prompt 边界不是边界（同禁自证纪律）。备选 B：新增 shared 标志位——否决，多一个旋钮且与 change-1 的"NULL=全局"口径冲突。取 NULL 归属集 = shared 面：项目车道见"本项目 ∪ 全局"，无项目上下文见全量（现行为，向后兼容）。越界 `read_document` 报"不存在"而非"无权"，不泄存在性。

**D3 · dataSources 用第三种引用种类 `library:<collectionId>`，不新开字段。**
备选=蓝图新增 `knowledgeBases[]` 段：否决——schema 膨胀且校验/试跑/diff 三链都要新分支。复用 `dataSources[].ref` 扩展命名空间，校验期解析 collection 可见性（作者账号内），实化时把引用编译为成员车道的库过滤参数；内容本体不进包（包携带引用，部署账号各自的同名集合不成立——引用解析只发生在铸造作者侧，实化产物把边界固化为该账号的 collection id）。

**D4 · nav 族=registry 的展示层元数据，客户端单源映射。**
备选 A：族进 RegistryEntry 由服务端下发——可行但动预设 schema 与三层解析面，本刀不值当。备选 B：纯前端硬编码分组——违反"registry 单源"纪律的展示变体，但族本身是呈现关注（与 label/icon 同层，surfaces.ts 注释已承认 presentation concerns）。取中：族映射与 slug 名册同文件（`surfaces.ts` 导出 FAMILY 表），谓词/预设解析先跑、族只对**已解析可见**的 slug 分组。

**D5 · 漏斗计数用既有筛选查询聚合，不新开统计端点。**
三段计数 = 同条件 layer 三次窄查询（或一次拉满 + 前端聚合，取实现侧更省者）。fd-memory 若已有 counts 聚合则直用——spike 后定，不影响 spec 行为（计数与列表口径一致即可测）。

## Risks / Trade-offs

- [cell 车道 mcp.json 生成链可能不吃 library server（未实证）] → tasks 首条 spike 先证；不通则走 browser-mcp 同款薄启动器形态，设计不变。
- [边界依赖 change-1 的 project 章；并行期无章] → 无章=全量（现行为），两 change 部署次序不敏感；边界随章增长自然收紧。
- [一键召唤房间成员同时吃两个门（room 供给 + 库边界）] → 房间车道成员即 fleet 部署成员，挂载一处、边界一处，e2e 各断一条。
- [漏斗 N+1 查询拖慢面板冷开] → 计数查询限窄（count-only），降级态沿用既有条款不放大。

## Migration Plan

1. spike（D1 挂载链）→ 2. 工具层边界（D2，向后兼容默认全量）→ 3. 蓝图引用种类（D3，存量蓝图不含 library:，零迁移）→ 4. 展示三件（族/漏斗/直链，纯增益）。
回滚：每步独立可回退；边界与引用种类若回退，存量蓝图/会话回到全量行为，无数据损坏。

## Open Questions

- 万星 console 侧部署成员的车道是否同样吃到挂载（rootKey lane 差异）——spike 时顺带观测，答案只影响测试面不影响 spec 条款。

## Spike 结论（1.1，2026-10-31 实证）

挂载链**已经存在**，不需新造薄启动器：

- `mcp.json` 顶层注册 `library`（`command: node`, `args: server/library-mcp.js`，stdio 模式）；
  `server.js#seedStartupMcpConfigs` 把它 seed 进 extensions 库（`source=startup`），
  dsh 桥的 `writeMcpPatch` 从该库生成 profile patch → **同 cell 的每个 dsh 回合都拿到
  `mcp__library__*` 四工具**，团队成员回合与智语召唤成员（各自 cell 同一部署 mcp.json）同理。
- `server/library-mcp.js` 同时支持 stdio 与 streamable-http 双模（`LIBRARY_MCP_HTTP_PORT>0`），
  跨 cell 供给也不需要新形态。

**因此 D1 的落点修正**：不需要「把 library 塞进车道」这一刀；真正缺的是
(a) **服务端检索边界**（project 归属过滤，2.2）、(b) **游客/匿名车道的工具排除**（2.3）。
任务 2.1 由「新增挂载」降级为「实测 + 回归断言」。
