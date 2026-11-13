# Proposal: add-deployment-secrets

## Why

萬星首个真实 pack（爬虫自愈）需要 git 子账号 PAT 注入（仅推分支权限），而部署描述符今天没有任何 secret 通道——pack 清单按设计禁带凭据（SERVING_FORBIDDEN_KEYS），billing key 有完整的「部署者粘贴→不透明引用→runner 经内部路由取值→pin 进 child 凭据文件」管线，任意 secret 没有对应通道。ADR-0014/萬星程序 C2：把这条已被生产验证的 fetch-pin 管线推广为每 agent 的部署密钥通道。

## What Changes

- deploy 请求可携带 **`secrets: { "<agentId>": { "<name>": "<value>" } }`**（部署者录入；名称 `[a-z0-9_]{1,32}`，每 agent ≤4 条，value ≤8KB）。
- 平台侧存储：`deployment_secrets` 表（与 deployment_keys 同库同信任模型——值存一次、引用下发），不透明引用 `ws_<hex>` 进描述符；**registry/市场/卡片任何公共面零 secret**。
- 生命周期对齐 billing key：重部署省略=保留；显式 `null` 逐名解绑；agent 停止 serving 时随部署清退。
- runner 侧：新增内部取值路由 `GET /api/packs/internal/secret/:ref`（registry 服务凭据认证、逐次审计）；compose 时把每个 secret **pin 进 child 的 `.credentials.yaml`**（env 已被洗刷，凭据文件是唯一到达 child 的通道）；取值失败=组合失败大声报错，**无静默缺省**。
- 全链路脱敏：日志/审计/部署面至多尾四位。

**非目标**：加密静态存储超出 deployment_keys 现状（同库同信任，后续统一升级）；轮换=重粘贴重部署；pack 清单携带 secret（维持禁止）；per-secret 作用域语义（child 内即全可见，权限收敛靠最小权限凭据本身）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `a2a-agent-serving`: 新增「部署按 agent 绑定部署者录入的密钥」——与 billing key 绑定需求同构的录入/校验/引用/生命周期。
- `agent-runner`: 新增「runner 经认证通道取 agent 密钥并注入 child 凭据文件」——取值路由、pin 行为、失败即组合失败。

## Impact

- **代码**：`gateway/packs.js`（录入/生命周期/内部路由/表）、`lib/agent-serving.js`（描述符 `secret_refs`）、`agent-runner/{manager,compose}.js`（取值+pin）。
- **安全**：新增 secret 值的存储面与内部取值路由（服务凭据门+审计，与 llm-key 路由同形）；公共面不变。
- **爬虫 pack 解锁**：git PAT（contents:write + pull_requests:write，无 admin）经此通道注入。
