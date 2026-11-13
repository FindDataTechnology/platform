## Why

批 6 ④ 归档时 A2A 试点 E2E 挂账，根因定谳为：platform `facet-proxy` 的 `timeoutMs` 硬编码 30s，`deployToRegistry` 逐技能匿名抓 `SKILL.md`（Gitee raw 302）+ `/api/agents` 分页累加超过 30s → 代理 30.1s 超时返回 502 → deploy handler 中位于 `deployToRegistry` 成功返回之后的 `registry.recordDeploymentKey` 永不执行 → `deployment_keys` 缺三行 → runner 拉键失败、child 未起 → A2A 回合 `-32003`。

用户裁决"三条全做"，本变更做**止血**：让代理超时可配且默认完全向后兼容，使带 `billingKeys` 的 deploy 能在超时前完成、键落库。治本项（逐技能抓取并发化/缓存）风险更大，单列后续 change，不在此动。

## What Changes

- `gateway/index.js` 的 `registerFacetProxy(app, {...})` 调用新增 opt-in 的 `timeoutMs`：仅当 `FACET_PROXY_TIMEOUT_MS` 为正数时传入；未配置/非法/非正一律不传，回落到 `facet-proxy.js` 的既有默认 30_000（**逐字节向后兼容**，不只影响 deploy，也不悄悄放宽其他代理请求的失败反馈）。
- `fd-infra-deploy/all-services/prod/platform.yaml` 的 platform Deployment 增 env `FACET_PROXY_TIMEOUT_MS=120000`。
- `gateway/facet-proxy.js` **不改**：已确认 `timeoutMs` 从 `registerFacetProxy` → `facetRequest` → `AbortSignal.timeout(timeoutMs)` 贯穿完整、无缺陷。
- 出片/滚动后重跑三单元 deploy，验证 `deployment_keys` 落库、runner 拉键、A2A 真回合与成功计费。

## Capabilities

### New Capabilities

- `facet-proxy-timeout`：platform facet 代理超时 opt-in 可配的行为契约（默认不变、env 生效范围、回滚方式）。

### Modified Capabilities

（无既有 spec 覆盖该代理通道）

## Impact

- **仓**：`paas/gateway/index.js`、`fd-infra-deploy/all-services/prod/platform.yaml`、本 change 目录。
- **运行**：platform 滚动重启一次（ArgoCD GitOps）；去掉 env 即秒级回滚到 30s。
- **不做**：不改 `deployToRegistry` 并发化、不改 facet 服务、不动 `facet-proxy.js` 默认值、不碰并发会话正在改的其他文件。
