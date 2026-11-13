# Design: add-deployment-secrets

## Context

billing key 管线（revise-billing-key-acquisition 实战定型）：deploy 粘贴→四层校验→`deployment_keys` 存值一次→`pk_` 引用进描述符→runner 经 `GET /api/packs/internal/llm-key/:ref`（registry 服务凭据）取值→`compose.js applyBillingKey` pin 进 child `.credentials.yaml`（child env 洗刷后凭据文件是唯一通道）。本变更=同管线推广到任意命名 secret。

## Goals / Non-Goals

**Goals**：deploy 录入 per-agent 命名 secret；引用化存储与描述符；runner 取值+pin；生命周期对齐 billing key；全链脱敏。

**Non-Goals**：静态加密升级（与 deployment_keys 同信任面，将来统一）；轮换流程（=重粘贴重部署）；pack 携带 secret（维持 SERVING_FORBIDDEN_KEYS）；secret 作用域/权限语义（最小权限在凭据签发侧解决）。

## Decisions

- **D1 形状与校验**：请求体 `secrets: {agentId: {name: value|null}}`；名称 `/^[a-z0-9_]{1,32}$/`（同时避免与凭据文件既有键冲突——保留前缀 `secret_` 可选，实施时以「拒绝与 provider ref 键同名」兜底）；每 agent ≤4 条；value ≤8KB、非空字符串；agent 必须 serving。
- **D2 存储**：`deployment_secrets(pack_id, agent_id, name, secret_ref, secret_value, deployer, created_at, PRIMARY KEY(pack_id, agent_id, name))`，`ws_<12B hex>` 引用；描述符字段 `secret_refs: {name: ref}`（仅引用）。
- **D3 取值路由**：`GET /api/packs/internal/secret/:ref`——与 llm-key 路由同门（registry 服务凭据 Bearer）、同审计形状（ref+agent，无值）。逐 secret 一次请求（简单、审计清晰；不做批量端点）。
- **D4 compose pin**：`materializeAgentHome` 后、spawn 前，manager 按 `secret_refs` 逐名取值写入 `.credentials.yaml`（yaml 追加键=name: value；复用 applyBillingKey 的读-改-写模式）；任一失败→抛错阻止 spawn，错误带 ref 名。
- **D5 生命周期**：deploy 时对齐 billing key 三态（省略=保留、null=解绑单名、停服清理）；重部署保留的 secret 不重验值（无 liveness 可言，存在即用）。
- **D6 脱敏**：录入/审计/部署面日志统一 `ws_xxx…last4`（value 尾四位）；API 永不回值。

## Risks / Open Items

- 凭据文件被 child 全量可读（无作用域）——接受（最小权限在签发侧：如 GitHub fine-grained PAT 只勾 contents:write+pull_requests:write）。
- e2e：staging 部署带 1 个假 secret 的 pack → child home `.credentials.yaml` 内断言键值在位、描述符/registry 无值；缺 ref 场景断言组合失败文案。
