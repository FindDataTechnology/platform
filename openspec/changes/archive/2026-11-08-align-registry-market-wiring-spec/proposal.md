# registry 市场接线 spec 校正（N-6）

## Why

审计 N-6 的原始 premise（「spec 仍钉 REGISTRY_URL 直喂」）已被 11-07 的
`4dd6e8336` 改写掉，spec 现在是 facet 优先。逐条对代码核后还剩五处与现势不符，
其中两处会误导运维、一处方向相反：

| # | spec 说法 | 代码实况 |
|---|---|---|
| 1 | 合并时「registry 条目与 bundled catalog 合并，**重名的以 bundled 为准**」 | 反的。`extension-store.js:194-196` 注释与 `:209-214` 实现都是**目录赢**：starter floor 被同名目录条目挤掉（supply 面才是 server 的真源） |
| 2 | 旧通道 `REGISTRY_URL` 是「文档化的回滚」 | 不止回滚：**agents 腿始终读 registry**，facet 模式下也读（`registry-bridge.js:571-580`），没有它就丢 a2a/cell 目录面 |
| 3 | 验证口径查「boot 日志里没有 `registry source disabled`」 | 该串代码中已不存在；当前两句是 `no catalog source; market serves the starter floor + generated snapshot`（`:737`）与废弃告警（`:748-750`） |
| 4 | 无源时「服务 bundled catalog」 | 两层：app 内置 starter floor + 生成的离线快照（`market-catalog.json` / `market-catalog-skills.json`，`extension-store.js:150-161,197-203`） |
| 5 | `configTemplate` 指向 `https://mcp.finddatatech.cloud/<name>/mcp` | 主机是**推导**的（`registry-bridge.js:239-241` 取配置的网关基址；facet 侧自带 endpoint `facet/mcp-catalog.js:92`），不是硬编码 |
| 6 | 废弃告警由 `getCatalogSource` 发出 | 由 `initRegistryBridge` 发出（`registry-bridge.js:740-751`）；`getCatalogSource` 只做选择 |

## What Changes

- `registry-market-deployment` R1：改写来源选择与优先级（facet 主 / 旧通道对 agents 腿仍必需
  + 回滚位），标注告警的真实出处，无源兜底改成两层，并补一句 facet 内部的
  `SUPPLY_STORE_CATALOG` 是另一道闸（不在本 spec 管辖）。
- R2：合并方向改成「目录赢、starter 落选」；补 agents 腿读 registry 的注记；`configTemplate`
  改成「配置的网关基址推导」。
- R3：验证口径改到真实日志串，并把 runbook 要求扩到 facet 连接配置（`FACET_CATALOG_URL`/
  `FACET_CATALOG_TOKEN`）——`DEPLOY.md` 目前只写旧通道，facet 只写在
  `docs/supply-store-cutover-runbook.md`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `registry-market-deployment`：三条 Requirement 按代码实况回写，场景全部保留。

## Impact

- 纯 spec 文本；零代码改动。
- 遗留（另单/外仓）：`DEPLOY.md:662` 与 `k8s/deployment.yaml:113` 两处注释还在引用已不存在的
  `registry source disabled` 串——本单只修 spec 的验证口径；文内注释属部署仓，需单独改。
