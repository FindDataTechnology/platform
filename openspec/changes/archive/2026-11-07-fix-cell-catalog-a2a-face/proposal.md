# Proposal: fix-cell-catalog-a2a-face

## Why

facet catalog 源（`add-supply-catalog-unification`）切换后，`doFacetRefresh` 只拉 mcp+skills **不拉 agents**，cell 目录的 a2a-mode 条目自切换日起为零——生产 4 cell 全部 **10 支 a2a 部署岗 status=vacant**（岗的 targetId `registry-packs-…` 在目录里已无对应条目）：既有的 a2a 岗全部下岗、新的 a2a 岗无法创建、O8 召唤正路径随之阻塞（vacant → servingPath=null）。registry 侧 a2a 服务面本身是活的（`/api/agents` 41 agents / 29 a2a enabled，pod 持 `MARKET_REGISTRY_TOKEN` 可读），断的只是 cell 目录这一段。

## What Changes

- **facet 源补拉 agents**：`registry-bridge.js` 的 `doFacetRefresh` 在 mcp+skills 成功后，best-effort 追加拉取 registry 的 `/api/agents`（分页 `fetchAllPages` + 既有 `mapAgent` 映射，`REGISTRY_URL`（`MARKET_REGISTRY_URL`/`REGISTRY_URL`）+ `REGISTRY_TOKEN` 同款凭据），填充 `agentSnapshot` → cell 目录恢复 a2a 条目（id 形态 `registry-packs-<packId>-<agentId>` 与存量岗 targetId 逐字吻合 → vacant 岗自动复活、member-add 恢复 a2a 目标枚举、fleet a2a 回合恢复）。
- **独立降级**：agents 拉取失败（registry 不可达/401/改版）只保 last-good agents 并 warn，**不拖累 facet mcp+skills 的成功刷新**——两个面独立新鲜度。
- **广播语义不变**：`market_changed` 信号仍只看 {mcpServers, skills}（agents 不进 market 面）。

### Non-Goals（显式划出，避免假修）

- **部署账本归一（O9b）不在本案**：a2a 岗的 pack 部署登记在萬星面账本（facade pod），本平台 facet 台账仅 1 行 demo——这些岗复活后 `servingPath` 有值、O8 召唤计划能如实列出对齐候选，但对不齐台账行的仍被诚实排除（summonable 空、呈现为驾驶舱指引）。「萬星面部署要不要可召、席位对哪本账本结算」是产品/架构决策，须用户拍板另立。
- facet pod 稳定性（O9c）是并发会话处置中的运维事项，非代码缺陷。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `supply-catalog`（或按实际 spec 名落点）：facet 源的读面从「mcp+skills 两物种」扩展为「mcp+skills（market 面）+ agents（chat/serving 面）」，agents 独立降级保 last-good。先查现役 spec 组织再定 delta 落点。

## Impact

- `registry-bridge.js`（`doFacetRefresh` 追加 agents 拉取；零新依赖）；
- `scripts/test-supply-catalog-yizuo.mjs`（facet 渠道补 agents 断言：填充/last-good 独立性/非 market 广播）；
- 生产行为变化：cell `/api/catalog` a2a 条目复活 → 既有 vacant 岗复活（server.js `reconcileAllFleets` 钩子随 catalog 变更重算）、member-add a2a 枚举恢复、O8 serving face 有真候选；
- 风险：registry agents 大列表的分页读时长（41 agents 单页内，`LIST_PAGE_LIMIT` 既有纪律）；`mapAgent` 对未启用/禁用条目的既有过滤（`is_enabled===false` → null）照旧。
