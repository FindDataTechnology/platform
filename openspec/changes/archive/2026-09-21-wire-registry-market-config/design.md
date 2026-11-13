## Context

`registry-bridge.js`（受 `extension-marketplace` / `agent-catalog` 规格覆盖）从 `MARKET_REGISTRY_URL || REGISTRY_URL` 读取 registry 地址、从 `MARKET_REGISTRY_TOKEN` 读取 Bearer token，启动时拉取 `/api/servers`、`/api/skills`、`/api/agents` 并按 TTL 刷新。生产部署清单 `k8s/deployment.yaml` 目前两者皆未设置，bridge 启动即 no-op（日志 "registry source disabled"）。实测 registry API 无 token 返回 401（nginx 层），因此 token 是硬前提。

**实现期勘误（2026-09-18 实地核查）**：线上实际运行的是 cheap 集群 `fd-prod` 命名空间的 platform（Harbor 镜像 `…:sha-92af7aa`，env 经 `envFrom` 注入 ConfigMap `platform-config` + Secret `platform-secrets`），而非本仓库 manifest 描述的 `default` 命名空间单容器布局——那是一份 0 副本的迁移遗留。下述决策以 fd-prod 实际形态为准。

## Goals / Non-Goals

**Goals:**
- 最小改动让生产 Store / Agents 呈现 registry 内容：manifest 加 2 个 env + 文档 + 部署后验证。
- token 不进仓库：走 `platform-secrets` Secret，manifest 只留引用。

**Non-Goals:**
- 不改 `registry-bridge.js` 及任何应用代码——合并、降级、组过滤、懒加载安装均已实现并有规格。
- 不引入 per-user token 透传（bridge 注释里提到的后续模式）。
- 不做 `registry-groups.json` 可见性分组——当前 registry 条目无组元数据，全部用户可见是预期行为；后续需要收紧时再单独变更。
- 不改 Jenkins/镜像构建链路（纯 env 变更，无需重建镜像）。

## Decisions

**D1: 用 `REGISTRY_URL` 而不是 `MARKET_REGISTRY_URL`。**
两者 bridge 都认；本地 `.env` 已用 `REGISTRY_URL=https://mcp.finddatatech.cloud`，保持同名使本地与生产读法一致。bridge 还用该值推导安装端点 `{REGISTRY_URL}/{path}/mcp`，单一变量避免两处配置漂移。

**D2: token 放 fd-prod 的 `platform-secrets` Secret 键 `MARKET_REGISTRY_TOKEN`，URL 放 `platform-config` ConfigMap。**
fd-prod 的容器用 `envFrom` 整体注入 ConfigMap + Secret，Secret 键名即环境变量名，无需改 deployment 对象。ConfigMap 存非敏感 URL，Secret 存 token，职责与现有键（`LLM_API_KEY`、`LOGTO_APP_SECRET`）一致。代价是 token 缺失/过期时无显式报错（bridge 降级静默）——用 D4 的验证口径兜住。

**D3: token 的获取路径写进 `DEPLOY.md`，不自动化；当前只有 8 小时会话 JWT。**
registry 管理界面（"Get JWT Token"）签发的是 8 小时过期的用户会话 JWT；可签发长效凭证的 IAM > M2M Accounts 页面在这套 registry 部署上 list 接口损坏（"Failed to load M2M clients" / "Unable to list IAM groups"，组创建成功但列表失败），M2M 账号暂不可用。runbook 如实记录该限制：token 过期后 bridge 401、条目以 last-good 留存至 pod 重启，随后 Store 优雅回退到 bundled 目录。长效方案（修 registry IAM 后改用 M2M 账号，或做自动重签）为独立后续变更。

**D4: 部署后验证以 `GET /api/extensions/market` 为准。**
接口返回条目名列表是最直接的机器可查信号（比看 UI 快，比看日志确定）。验证标准：返回集合包含 registry 当前启用的条目（fd-cn-report、fd-daas-mcp、fd-open-data-mcp、law-bench、airegistry-tools / contract-review 等），且 bundled 条目不丢。

**备选方案（否决）：** 把 token 以 build-arg 烧进镜像——引入镜像内秘密，违背现有 Secret 模式；用 `MARKET_REGISTRY_URL` 新变量名——与本地 `.env` 现状不一致，无收益。

## Risks / Trade-offs

- [registry 401/不可达] → 已有 last-good 降级 + 警告日志；Store 永远有 bundled 目录兜底。
- [token 泄露面扩大（进入 pod env）] → 与 `LLM_API_KEY` 同级现状；registry token 仅可读目录，签发时可设较小权限/较长轮换周期。
- [Secret 先于 manifest 或反之的顺序问题] → `optional: true` 使任意顺序都能起 pod；补齐后重启即生效。
- [线上实际 manifest 与仓库漂移（cheap-5 手工 apply）] → tasks 里包含"确认线上生效以 API 验证为准"，不信任 apply 回显。

## Migration Plan

1. 合并本变更（manifest + 文档）。
2. 运维按 `DEPLOY.md`：registry 管理界面签发 token → `kubectl patch secret platform-secrets`（fd-prod）→ `kubectl patch configmap platform-config` 设 `REGISTRY_URL` → rollout restart。
3. 验证 `GET /api/extensions/market` 出现 registry 条目、`/api/catalog` 出现 `registry-*` agent、boot 日志无 "registry source disabled"。
4. 回滚：删除 ConfigMap/Secret 里的两个键并重启，即回到纯 bundled 目录，无数据残留（bridge 快照仅存内存）。

## Open Questions

- **token 生命周期（已升级为已知限制，见 D3）**：当前只能拿到 8 小时会话 JWT；registry 侧 IAM list 接口修复后应改用 M2M 长效账号，或引入自动重签——独立后续变更。
- **registry IAM list 接口损坏**（"Failed to load M2M clients" / "Unable to list IAM groups"，创建正常）——需在 registry（mcp-gateway-registry）侧排查修复。
