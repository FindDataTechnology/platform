# Tasks: add-deployment-secrets

## 1. 平台侧

- [x] 1.1 `gateway/packs.js`：`deployment_secrets` 表 + secrets 录入校验（名称/条数/大小/目标 agent serving）+ 生命周期三态（省略保留/null 解绑/停服清理）+ 描述符 `secret_refs`（`lib/agent-serving.js`）。验证：单测覆盖录入/拒绝/三态/公共面无值
- [x] 1.2 内部取值路由 `GET /api/packs/internal/secret/:ref`（服务凭据门 + 审计 ref/agent 无值 + 脱敏工具）。验证：单测——无凭据 401/有凭据 200 回值/未知 ref 404/审计行形状

## 2. runner 侧

- [x] 2.1 `agent-runner/{manager,compose}.js`：按 `secret_refs` 取值并 pin 进 `.credentials.yaml`（复用 applyBillingKey 读改写模式）；任一失败→组合失败带 ref 名、无部分集、无兜底。验证：单测——两 secret 全 pin/一缺即失败/取值路由只被服务凭据调用
- [x] 2.2 回归：无 secrets 描述符的组合路径零变化。验证：`scripts/test-agent-runner.mjs` 全绿

## 3. 端到端与文档

- [x] 3.1 staging e2e（fd-prod+cheap1 runner 实跑，scripts/probe-deployment-secrets.mjs ALL GREEN）：录入/脱敏(ws_…last4)/secret-bindings 面板/公共面与 registry 零值/child .credentials.yaml 值在位/悬空 ref 组合大声失败(ref 指名)
- [x] 3.2 文档：DEPLOY.md 密钥段（录入形状/生命周期/最小权限示例：GitHub fine-grained PAT contents:write+pull_requests:write）。验证：文段与 spec 一致
