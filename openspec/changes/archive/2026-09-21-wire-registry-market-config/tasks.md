## 1. Manifest 接线

- [x] 1.1 在 `k8s/deployment.yaml` platform 容器 env 中新增 `REGISTRY_URL=https://mcp.finddatatech.cloud`（明文值，附注释说明用途：registry-bridge 市场数据源 + 安装端点推导），紧跟 `LLM_API_KEY` 块之后；验证：`kubectl apply --dry-run=client -f k8s/deployment.yaml` 或 YAML 解析通过。
- [x] 1.2 同文件新增 `MARKET_REGISTRY_TOKEN`，`valueFrom.secretKeyRef` 指向 `platform-secrets` / `market-registry-token`，`optional: true`，注释给出 Secret 创建命令（与 `LLM_API_KEY` 注释同风格）；验证同 1.1。

## 2. 运维文档

- [x] 2.1 `DEPLOY.md` 新增「Registry 市场 token」章节：registry 管理界面（管理员）签发 token → `kubectl -n default patch secret platform-secrets -p '{"stringData":{"market-registry-token":"<token>"}}'` → apply manifest + rollout restart → 验证步骤（`GET /api/extensions/market` 含 registry 条目、boot 日志无 "registry source disabled"）。验证：按文档命令逐条可执行（kubectl 语法自查）。

## 3. 部署与线上验证

- [x] 3.1 运维步骤执行：生成/写入 token，注入线上部署，重启。**实现期勘误：线上实际是 cheap 集群 `fd-prod` 命名空间（envFrom 注入），非 `default` 的旧 manifest 布局**。实际执行：registry 管理界面签发 8h 会话 JWT → `kubectl -n fd-prod patch secret platform-secrets`（键 `MARKET_REGISTRY_TOKEN`）→ `kubectl -n fd-prod patch configmap platform-config`（键 `REGISTRY_URL`）→ rollout restart。验证：pod Ready、`exec` 确认 pod 内 `REGISTRY_URL`/`MARKET_REGISTRY_TOKEN` 已注入、日志无 disabled/401 告警。⚠️ 已知限制：registry UI 只能签发 8 小时会话 JWT（IAM M2M 页 list 接口损坏，无法建长效账号）；过期后 Store 优雅回退 bundled-only（详见 DEPLOY.md 与 design.md D3）。
- [x] 3.2 线上效果验证（2026-09-18，认证态 API）：`GET /api/extensions/market` 返回 MCP 15 个（bundled 10 + registry 5：fd-cn-report、fd-daas-mcp、fd-open-data-mcp、law-bench、airegistry-tools）、技能 27 个（bundled 5 + registry 22：contract-review、financial-statement-analysis、legal-research-cn 等）；`GET /api/catalog` 返回 local + registry-chatlaw + registry-fingpt。Store 页 MCP/Skills 标签、Agents 页均可见 registry 条目。default 命名空间的误 patch/secret 已还原清理。
