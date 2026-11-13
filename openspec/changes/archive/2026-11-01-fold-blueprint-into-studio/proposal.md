## Why

蓝图构造间是第 4 个独立构建器：与 Agent Studio 并存意味着团队结构有两套编辑 UX，且蓝图表单轨只覆盖 boundary/dataSources/judgeModel，其余靠 JSON 轨。而蓝图的底层早已复用 pack manifest + fleet-template 同一批校验器——折叠的只是编辑面，不动生命周期。这是 `add-agent-studio` D8 预留的收编步。

## What Changes

- **蓝图创作工作面移入 Agent Studio「团队模式」**：蓝图创建/编辑（双轨）/校验/diff/试跑/铸造入口，全部经 Studio 的团队模式承载；蓝图内容 = Agent Document（三桶卡可编辑）+ 蓝图专属段（boundary / dataSources / judgeModel / monitoring / acceptance / board，表单承载）。
- **`BlueprintStudioPage` 退役**：路由摘除或重定向到 Studio 团队模式；`/api/blueprints` 服务端零改。
- **生命周期零改**：批准双钥匙、试跑真源、铸造追溯、判据纪律、v1 方言拒绝——全部需求照旧；本 change 只换工作面的所在。
- **NL 起草通道照旧**：蓝图构造师工具面仍可直通草稿池（产物落 Studio 团队模式画布）。
- **明确 Non-goals**：不改蓝图内容形状；不改批准/铸造/试跑语义；不做可写团队图（Studio v1 边界不变）；不动 fleet 段校验。
- **非 BREAKING**：既有蓝图草稿/已批准/已铸造数据零迁移。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `fleet-blueprint-studio`: 「工作室提供编辑→校验→diff 的工作面」需求改为——工作面由 Agent Studio 团队模式承载（表单+JSON 双轨、草稿不落库、NL 起草通道、批准前零落地的语义全部保留）。

## Impact

- **Web**：`BlueprintStudioPage` 退役；Studio 增加蓝图文档类型的团队模式（依赖 `add-agent-studio` 已落地）。
- **Server**：`/api/blueprints` 及蓝图校验/试跑/铸造链零改。
- **顺序**：须在 `add-agent-studio` 之后（其 D8 已声明此收编）；归档次序注意与 `add-agent-studio` 的 delta 不冲突（本 change 不触碰 `agent-studio` 能力）。
