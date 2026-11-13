## Why

线上 platform（craw.finddatatech.cloud）的 Store 只显示打包的静态目录（10 个演示 MCP + 5 个通用技能），mcp.finddatatech.cloud registry 上注册的全部业务内容——5 个 MCP 服务（fd-cn-report、fd-daas-mcp、fd-open-data-mcp、law-bench、AI Registry tools）、3 个技能（contract-review、financial-statement-analysis、legal-research-cn）、2 个 agent（ChatLaw、FinGPT）——一个都没有出现。代码侧的 `registry-bridge.js` 已实现并在 `extension-marketplace` spec 中有完整规格，但 `k8s/deployment.yaml` 既没有设置 `REGISTRY_URL`，也没有设置 `MARKET_REGISTRY_TOKEN`（registry API 实测无 Bearer token 返回 401），导致 bridge 在生产环境启动即打印 "registry source disabled" 后永久空转。这是纯粹的部署配置缺口，不是代码缺陷。

## What Changes

- `k8s/deployment.yaml` 的 platform 容器新增 `REGISTRY_URL` 环境变量（明文值 `https://mcp.finddatatech.cloud`）。
- `k8s/deployment.yaml` 新增 `MARKET_REGISTRY_TOKEN` 环境变量，从已有的 `platform-secrets` Secret 读取 `market-registry-token` 键（与 `LLM_API_KEY` 同模式，`optional: true`，缺 token 时 bridge 拉取失败但保持 last-good 降级，不阻塞启动）。
- `DEPLOY.md` 补充运维步骤：如何在 registry 管理界面生成服务 token、如何写入 Secret（`kubectl -n default create secret ... --from-literal=market-registry-token=...` 或 patch 已有 Secret）、改完后如何重启并验证。
- 验证口径写进文档：部署后 `GET /api/extensions/market` 应包含 registry 条目，Store 各页应能看到 registry 的 MCP/技能，Agents 页应出现 registry 的链接型 agent。

## Capabilities

### New Capabilities
- `registry-market-deployment`: 生产部署接线 registry 市场数据源——manifest 提供 `REGISTRY_URL` 与来自 Secret 的 `MARKET_REGISTRY_TOKEN`，使 `extension-marketplace` 已规格化的 registry 合并行为在生产环境生效；涵盖 token 的 Secret 化管理与部署后验证。

### Modified Capabilities
<!-- extension-marketplace 的需求不变：registry 合并行为已在既有规格中定义，本变更只是让它在线上被启用。 -->

## Impact

- **部署**：`k8s/deployment.yaml`（新增 2 个 env）；cheap-5 集群 `platform-secrets` Secret 新增 1 个键；pod 重启一次。
- **运维文档**：`DEPLOY.md` 新增 registry token 章节。
- **应用代码**：零改动。`registry-bridge.js` / `extension-store.js` / `catalog.js` 已实现全部行为，受 `extension-marketplace`、`agent-catalog` 既有规格覆盖。
- **运行时效果**：bridge 首次拉取后 Store 出现 registry 条目（TTL 300s 刷新，`market_changed` WS 广播）；registry-sourced MCP 安装模板指向 `https://mcp.finddatatech.cloud/<name>/mcp`，用户安装时填自己的网关 token；技能安装时服务端按内容路径懒加载 SKILL.md；Agents 页出现 `registry-*` 链接型条目。
- **风险**：registry 不可达时保持 bundled 目录 + last-good（已有降级路径）；token 缺失时仅 registry 条目缺席，不影响启动。
